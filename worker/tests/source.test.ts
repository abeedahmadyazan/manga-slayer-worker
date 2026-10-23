import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Env,firestoreDocument,firestoreRequest} from '../src/index';
import {handleCommentRoutes,commentAvatarUrl,legacyCommentDate} from '../src/comments';
import {protectRequest} from '../src/security';
import {handleSourceRoutes,refreshSourceIndexes} from '../src/source';
import {loadDiscussionNumbers} from '../src/discussion-numbers';
import {ChapterEntry,chapterSlot,mergeChapterEntries,loadChapterIndex,saveChapterIndex} from '../src/chapter-index';

const db=new DatabaseSync(':memory:');
let queryCount=0;
for(const file of ['0001_init.sql','0002_comment_indexes.sql','0003_source_index.sql','0004_translation_index.sql','0005_compact_source.sql','0006_discussion_numbers.sql']) db.exec(readFileSync('migrations/'+file,'utf8'));
class Statement {
 args:any[]=[];
 constructor(public sql:string){}
 bind(...args:any[]){this.args=args;return this;}
 async first(){queryCount++;return db.prepare(this.sql).get(...this.args)??null;}
 async all(){queryCount++;return {results:db.prepare(this.sql).all(...this.args)};}
 async run(){queryCount++;const value=db.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:Number(value.changes)}};}
}
const store={prepare:(sql:string)=>new Statement(sql),batch:async(statements:Statement[])=>{
 db.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}
}};
const env={DB:store,FIREBASE_PROJECT_ID:'test'} as unknown as Env;
const origin='https://yz-manga-api-v2.yznabyd.workers.dev';
const claims={sub:'author',aud:'test',iss:'test',iat:1,auth_time:1,exp:9999999999};
let passed=0;
async function check(name:string,fn:()=>unknown){await fn();passed++;console.log('PASS',name);}
async function put(path:string,data:Record<string,unknown>){assert.equal((await firestoreRequest(env,'/'+path,{method:'PATCH',body:JSON.stringify(firestoreDocument(path,data))})).status,200);}
async function listComments(){const result=await handleCommentRoutes(new Request(origin+'/manga-app-api/get-chapter-comments?chapter_id=123'),env,claims);assert.equal(result!.status,200);return (await result!.json() as any).response.data;}
await check('comment time matches legacy parser timezone, preserving elapsed minutes and date rollover',()=>{
 for(const iso of ['2026-10-23T18:55:17.123Z','2026-10-23T23:58:09.000Z','2026-12-31T23:59:59.999Z']) {
  const formatted=legacyCommentDate(iso);
  assert.match(formatted,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const parsed=Date.parse(formatted.replace(' ','T')+'+05:00');
  assert(Math.abs(parsed-Date.parse(iso))<1000);
  const now=Date.parse(iso)+7*60*1000;
  assert.equal(Math.floor((now-parsed)/60000),7);
 }
 assert.equal(legacyCommentDate('2026-10-24 04:58:09'),'2026-10-24 04:58:09');
 assert.equal(legacyCommentDate('invalid'),'');
});
await check('existing comments follow current profile picture, replacement and removal',async()=>{
 await put('profiles/author',{displayName:'Author',legacyId:5,avatarRevision:'revision111'});
 await put('comments/77',{id:77,uid:'author',kind:'chapter',targetId:123,parentId:0,text:'Existing comment',avatarUrl:''});
 assert.equal((await listComments())[0].user_image_url,origin+'/avatars/author/revision111');
 await put('profiles/author',{displayName:'Author',legacyId:5,avatarRevision:'revision222'});
 assert.equal((await listComments())[0].user_image_url,origin+'/avatars/author/revision222');
 await put('profiles/author',{displayName:'Author',legacyId:5,avatarRevision:''});
 assert.equal((await listComments())[0].user_image_url,'');
 assert.equal(commentAvatarUrl({avatarRevision:'../unsafe'},'author',origin),'');
});
await check('new comments return current picture immediately',async()=>{
 await put('profiles/author',{displayName:'Author',legacyId:5,avatarRevision:'revision333'});
 const response=await handleCommentRoutes(new Request(origin+'/manga-app-api/add-chapter-comment',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'chapter_id=123&comment_text=New+comment'}),env,claims);
 assert.equal(response!.status,200);assert.equal((await response!.json() as any).response.data.user_image_url,origin+'/avatars/author/revision333');
});
await check('chapter and manga replies carry current author image on create, reload and replacement',async()=>{
 for(const kind of ['chapter','manga']) {
  const parent=kind==='chapter'?81:82;
  await put('comments/'+parent,{id:parent,kind,targetId:123,parentId:0,uid:'author',text:'Parent',repliesCount:0});
  await put('profiles/author/postGate/shared',{lastAt:1});
  const reply=await handleCommentRoutes(new Request(origin+`/manga-app-api/add-${kind}-comment-reply`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:`${kind}_comment_id=${parent}&reply_text=Reply+${kind}`}),env,claims);
  assert.equal(reply!.status,200);const created=(await reply!.json() as any).response.data;
  assert.equal(created.user_image_url,origin+'/avatars/author/revision333');
  assert.equal(created[`${kind}_comment_reply_id`],created.comment_reply_id);
  await put('profiles/author',{displayName:'Author',legacyId:5,avatarRevision:'revision444'});
  const list=await handleCommentRoutes(new Request(origin+`/manga-app-api/get-${kind}-comment-replies?${kind}_comment_id=${parent}`),env,claims);
  assert.equal(list!.status,200);assert.equal((await list!.json() as any).response.data[0].user_image_url,origin+'/avatars/author/revision444');
  await put('profiles/author',{displayName:'Author',legacyId:5,avatarRevision:'revision333'});
 }
});
await check('native bodyless DELETE supports comment/reply query IDs and preserves ownership',async()=>{
 for(const kind of ['chapter','manga']) {
  const parent=kind==='chapter'?91:92,replyId=parent+10;
  await put('comments/'+parent,{id:parent,kind,targetId:500,parentId:0,uid:'author',text:'Parent',repliesCount:1});
  await put('comments/'+replyId,{id:replyId,kind,targetId:500,parentId:parent,uid:'author',text:'Reply'});
  const uri=origin+`/manga-app-api/delete-${kind}-comment-reply?${kind}_comment_reply_id=${replyId}`;
  assert.equal((await handleCommentRoutes(new Request(uri,{method:'DELETE'}),env,{...claims,sub:'other'}))!.status,403);
  const stream=new ReadableStream({start(controller){controller.close();}});
  const rawRequest=new Request(uri,{method:'DELETE',headers:{'content-length':'0'},body:stream,duplex:'half'} as RequestInit);
  const guarded=await protectRequest(rawRequest,{REQUEST_LIMITER:{limit:async()=>({success:true})},CATALOG_LIMITER:{limit:async()=>({success:true})},DOWNLOAD_LIMITER:{limit:async()=>({success:true})}});
  assert(guarded instanceof Request);
  assert.equal((await handleCommentRoutes(guarded,env,claims))!.status,200);
  assert.equal((await firestoreRequest(env,'/comments/'+replyId)).status,404);
  assert.equal((await (await firestoreRequest(env,'/comments/'+parent)).json() as any).fields.repliesCount.integerValue,'0');
  await put('comments/'+replyId,{id:replyId,kind,targetId:500,parentId:parent,uid:'author',text:'Another reply'});
  await put('profiles/author/chapterCounters/500',{count:2});
  const deleteParent=origin+`/manga-app-api/delete-${kind}-comment?${kind}_comment_id=${parent}`;
  assert.equal((await handleCommentRoutes(new Request(deleteParent),env,claims))!.status,405);
  assert.equal((await handleCommentRoutes(new Request(deleteParent,{method:'DELETE'}),env,claims))!.status,200);
  assert.equal((await firestoreRequest(env,'/comments/'+parent)).status,404);
  assert.equal((await firestoreRequest(env,'/comments/'+replyId)).status,404);
  if(kind==='chapter')assert.equal((await (await firestoreRequest(env,'/profiles/author/chapterCounters/500')).json() as any).fields.count.integerValue,'1');
 }
});
await check('DELETE form-body compatibility and conflicting IDs validation',async()=>{
 await put('comments/95',{id:95,kind:'chapter',targetId:501,parentId:0,uid:'author',text:'Parent'});
 const path=origin+'/manga-app-api/delete-chapter-comment';
 const conflict=await handleCommentRoutes(new Request(path+'?chapter_comment_id=95',{method:'DELETE',headers:{'content-type':'application/x-www-form-urlencoded'},body:'chapter_comment_id=96'}),env,claims);
 assert.equal(conflict!.status,400);
 const result=await handleCommentRoutes(new Request(path,{method:'DELETE',headers:{'content-type':'application/x-www-form-urlencoded'},body:'chapter_comment_id=95'}),env,claims);
 assert.equal(result!.status,200);
});
const entry=(n:number,readable=false):ChapterEntry=>({slot:String(n),chapter_id:1000+n,manga_id:1,chapter_number:n,chapter_label:String(n),chapter_name:'Chapter '+n,chapter_folder_name:readable?'arabic-id':'',url:'/reader/'+(1000+n),date_upload:0,chapter_watched_history_by_user:'No',readable,credits:''});
await check('number index survives missing upstream chapters and keeps discussion IDs',()=>{
 const old=[entry(1145)];const updated={...entry(1145,true),chapter_id:99999,url:'/reader/99999'};
 const merged=mergeChapterEntries(old,[updated,entry(1146)]);
 assert.equal(merged.length,2);assert.equal(merged[1].chapter_id,2145);assert.equal(merged[1].readable,true);
 assert.deepEqual(mergeChapterEntries(merged,[]),merged);
 assert.equal(chapterSlot('001.5'),'1.5');assert.equal(chapterSlot('none'),null);
});
await check('large chapter index persists in bounded bulk queries with reader mappings',async()=>{
 const values=Array.from({length:720},(_,i)=>entry(i+1,i===0));
 await saveChapterIndex(env.DB,1,values);
 const rows=await loadChapterIndex(env.DB,1);assert.equal(rows.length,720);assert.equal(rows[0].chapter_number,720);
 const mapping=await firestoreRequest(env,'/sourceChapters/1001');assert.equal((await mapping.json() as any).fields.readable.booleanValue,true);
});
let upstream=0;let fail=false;
const realFetch=globalThis.fetch;
globalThis.fetch=async(input:any)=>{
 upstream++;if(fail)throw new Error('offline');const url=new URL(String(input));
 if(url.pathname==='/manga')return Response.json({result:'ok',total:2,data:[{id:'has-chapters',attributes:{title:{en:'Published'},tags:[],latestUploadedChapter:'english'},relationships:[]},{id:'empty',attributes:{title:{en:'Empty'},tags:[]},relationships:[]}]});
 if(url.pathname.endsWith('/aggregate'))return Response.json({result:'ok',volumes:url.pathname.includes('/empty/')?{}:{'1':{chapters:{'1145':{chapter:'1145',id:'english'}}}}});
 if(url.pathname.endsWith('/feed'))return Response.json({result:'ok',total:0,data:[]});
 if(url.pathname==='/chapter')return Response.json({result:'ok',data:[{id:'english',attributes:{chapter:'1145',pages:15,translatedLanguage:'en'},relationships:[]}]});
 throw new Error('Unexpected upstream '+url);
};
await check('empty titles hidden and opened chapter numbers served without another provider call',async()=>{
 const response=await handleSourceRoutes(new Request(origin+'/manga-app-api/get-all-published-manga?limit=2'),env);
 assert.equal(response!.status,200);const rows=(await response!.json() as any).response.data;
 assert.equal(rows.length,1);assert.equal(rows[0].manga_name,'Published');assert.equal(rows[0].latest_chapter_name,'الفصل 1145');
 const path=origin+'/manga-app-api/get-published-manga-details-info?chapters=true&manga_id='+rows[0].manga_id;
 const first=await handleSourceRoutes(new Request(path),env);assert.equal((await first!.json() as any).response.data.length,1);
 const calls=upstream;const second=await handleSourceRoutes(new Request(path),env);assert.equal((await second!.json() as any).response.data.length,1);assert.equal(upstream,calls);
 fail=true;db.exec('UPDATE source_sync SET synced_at=0,arabic_synced_at=0');
 const fallback=await handleSourceRoutes(new Request(path),env);assert.equal((await fallback!.json() as any).response.data.length,1);
 const html=await handleSourceRoutes(new Request(origin+'/reader/'+rows[0].latest_chapter_id),env);
 assert.equal(html!.status,200);assert((await html!.text()).includes('رقم الفصل محفوظ'));
});
await check('catalog does not import entire chapter libraries, repeated browsing writes no rows, opening preserves all numbers',async()=>{
 globalThis.fetch=async(input:any)=>{
  const url=new URL(String(input));
  if(url.pathname==='/manga')return Response.json({result:'ok',total:1,data:[{id:'quota-title',attributes:{title:{en:'Quota regression'},tags:[],latestUploadedChapter:'q1199'},relationships:[{type:'cover_art',attributes:{fileName:'cover.jpg'}}]}]});
  if(url.pathname.endsWith('/aggregate'))return Response.json({result:'ok',volumes:{'1':{chapters:Object.fromEntries(Array.from({length:1200},(_,i)=>[String(i+1),{chapter:String(i+1),id:'q'+i}]))}}});
  if(url.pathname==='/chapter')return Response.json({result:'ok',data:[{id:'q1199',attributes:{chapter:'1200',pages:15,translatedLanguage:'en'},relationships:[]}]});
  throw new Error('Unexpected quota request '+url);
 };
 const uri=origin+'/manga-app-api/get-all-published-manga?search=quota';
 const first=await handleSourceRoutes(new Request(uri),env);
 assert.equal(first!.status,200);
 const card=(await first!.json() as any).response.data[0];
 assert.equal(card.latest_chapter_name,'الفصل 1200');
 assert.equal((await loadChapterIndex(env.DB,card.manga_id)).length,1,'catalog stores one latest slot instead of 1200');
 assert.equal(db.prepare('SELECT * FROM source_sync WHERE manga_id=?').get(card.manga_id),undefined,'catalog does not enroll unopened titles in background full sync');
 const before=Number((db.prepare('SELECT total_changes() AS n').get() as any).n);
 const again=await handleSourceRoutes(new Request(uri),env);assert.equal(again!.status,200);
 assert.equal(Number((db.prepare('SELECT total_changes() AS n').get() as any).n),before,'cached catalog including cover mapping must perform zero row writes');
 const opened=await handleSourceRoutes(new Request(origin+'/manga-app-api/get-published-manga-details-info?chapters=true&manga_id='+card.manga_id),env);
 assert.equal(opened!.status,200);
 const numbers=(await opened!.json() as any).response.data;
 assert.equal(numbers.length,1200);
 assert.equal(numbers[0].chapter_id,Number(card.latest_chapter_id),'latest discussion ID remains stable');
 assert.equal((await loadChapterIndex(env.DB,card.manga_id)).length,1200);
 const readBefore=Number((db.prepare('SELECT total_changes() AS n').get() as any).n);
 await handleSourceRoutes(new Request(origin+'/manga-app-api/get-published-manga-details-info?chapters=true&manga_id='+card.manga_id),env);
 assert.equal(Number((db.prepare('SELECT total_changes() AS n').get() as any).n),readBefore,'reopening cached chapter list must perform zero row writes');
});
await check('page images and ZIP downloads use supported Workers redirect mode and reject redirects',async()=>{
 await put('sourceImages/321',{url:'https://uploads.mangadex.org/test-page.jpg'});
 await put('sourceChapters/322',{remoteId:'test-chapter',readable:true});
 let redirect=false;
 globalThis.fetch=async(input:any,init?:RequestInit)=>{
  const url=String(input);
  if(url.includes('/at-home/server/'))return Response.json({result:'ok',baseUrl:'https://uploads.mangadex.org',chapter:{hash:'hash',dataSaver:['page.jpg']}});
  assert.equal(init?.redirect,'manual','Cloudflare rejects redirect:error');
  return redirect ? new Response(null,{status:302,headers:{location:'https://untrusted.example/image.jpg'}}) : new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpeg'}});
 };
 const image=await handleSourceRoutes(new Request(origin+'/source-image/321'),env);
 assert.equal(image!.status,200);assert.equal(image!.headers.get('content-type'),'image/jpeg');assert.equal((await image!.arrayBuffer()).byteLength,4);
 const zip=await handleSourceRoutes(new Request(origin+'/manga-app-api/download-chapter-as-zip?chapter_id=322'),env);
 assert.equal(zip!.status,200);assert.equal(zip!.headers.get('content-type'),'application/zip');
 redirect=true;
 assert.equal((await handleSourceRoutes(new Request(origin+'/source-image/321'),env))!.status,502);
 assert.equal((await handleSourceRoutes(new Request(origin+'/manga-app-api/download-chapter-as-zip?chapter_id=322'),env))!.status,502);
});
await check('multilingual pages prefer Arabic then English then other languages, preserve IDs, and cache the result',async()=>{
 const manga=900;
 await put('sourceManga/'+manga,{remoteId:'multilingual-test'});
 await saveChapterIndex(env.DB,manga,[{...entry(1),manga_id:manga,chapter_id:777,url:'/reader/777'}]);
 const aggregate=(chapters:any[])=>({result:'ok',volumes:{'1':{chapters:Object.fromEntries(chapters.map(c=>[String(c.chapter),c]))}}});
 let calls=0;
 globalThis.fetch=async(input:any)=>{
  calls++;const url=new URL(String(input));
  if(url.pathname.endsWith('/aggregate')) {
   const lang=url.searchParams.get('translatedLanguage[]');
   return Response.json(aggregate(lang==='ar'?[{chapter:'1',id:'ar1'},{chapter:'2',id:'ar2'}]:lang==='en'?[{chapter:'1',id:'en1'},{chapter:'2',id:'en2'},{chapter:'3',id:'en3'}]:[{chapter:'1',id:'pt1'},{chapter:'2',id:'pt2'},{chapter:'3',id:'pt3'},{chapter:'4',id:'pt4'},{chapter:null,id:'special-pt'}]));
  }
  if(url.pathname==='/chapter')return Response.json({result:'ok',data:url.searchParams.getAll('ids[]').map(id=>({id,attributes:{chapter:id==='special-pt'?null:id.slice(2),translatedLanguage:id.startsWith('ar')?'ar':id.startsWith('en')?'en':'pt-br',pages:id==='ar2'?0:15,readableAt:'2026-01-01T00:00:00Z'},relationships:[]}))});
  throw new Error('Unexpected multilingual request');
 };
 const uri=origin+'/manga-app-api/get-published-manga-details-info?manga_id=900&chapters=true';
 const result=await handleSourceRoutes(new Request(uri),env);assert.equal(result!.status,200);
 const values=(await result!.json() as any).response.data;
 assert.equal(values.length,5);
 const byNumber=new Map(values.map((value:any)=>[value.chapter_number,value]));
 assert.equal((byNumber.get(1) as any).language,'ar');assert.equal((byNumber.get(1) as any).chapter_id,777);
 assert.equal((byNumber.get(2) as any).language,'en');assert.equal((byNumber.get(3) as any).language,'en');
 assert.equal((byNumber.get(4) as any).language,'pt-br');assert((byNumber.get(4) as any).chapter_name.includes('البرتغالية'));
 assert(values.some((value:any)=>value.chapter_label==='خاص' && value.readable));
 const mapping=await firestoreRequest(env,'/sourceChapters/777');assert.equal((await mapping.json() as any).fields.remoteId.stringValue,'ar1');
 const before=calls;await handleSourceRoutes(new Request(uri),env);assert.equal(calls,before);
});
await check('removed translation switches reader to an available version without changing discussion ID',async()=>{
 const missing='11111111-1111-1111-1111-111111111111',working='22222222-2222-2222-2222-222222222222';
 await saveChapterIndex(env.DB,999,[{...entry(5,true),manga_id:999,chapter_id:888,chapter_folder_name:missing,language:'en',alternatives_json:JSON.stringify([missing,working])}]);
 globalThis.fetch=async(input:any)=>{
  const url=String(input);
  if(url.includes('/at-home/server/'+missing))return Response.json({result:'error'},{status:404});
  if(url.includes('/at-home/server/'+working))return Response.json({result:'ok',baseUrl:'https://uploads.mangadex.org',chapter:{hash:'hash',dataSaver:['page.jpg']}});
  if(url.includes('/chapter/'+working))return Response.json({result:'ok',data:{attributes:{translatedLanguage:'pt-br'},relationships:[]}});
  throw new Error('Unexpected translation fallback request');
 };
 const response=await handleSourceRoutes(new Request(origin+'/reader/888'),env);
 assert.equal(response!.status,200);assert((await response!.text()).includes('<img '));
 const mapping=(await (await firestoreRequest(env,'/sourceChapters/888')).json() as any).fields;
 assert.equal(mapping.remoteId.stringValue,working);assert.equal(mapping.language.stringValue,'pt-br');
 const saved=await loadChapterIndex(env.DB,999);assert.equal(saved[0].chapter_id,888);assert.equal(saved[0].language,'pt-br');
});

await check('cold 30-title catalog fits Free query limit and never stores cover mappings',async()=>{
 const items=Array.from({length:30},(_,i)=>({id:'free-title-'+i,attributes:{title:{en:'Free '+i},tags:[],latestUploadedChapter:'latest-free-'+i},relationships:[{type:'cover_art',attributes:{fileName:'cover.jpg'}}]}));
 globalThis.fetch=async(input:any)=>{
  const url=new URL(String(input));
  if(url.pathname==='/manga')return Response.json({result:'ok',total:30,data:items});
  if(url.pathname==='/chapter')return Response.json({result:'ok',data:items.map(item=>({id:item.attributes.latestUploadedChapter,attributes:{chapter:'1200',pages:20,translatedLanguage:'en'},relationships:[]}))});
  throw new Error('Catalog must not fetch an aggregate for every title');
 };
 const uri=origin+'/manga-app-api/get-all-published-manga?search=free-batch&limit=30';
 const start=queryCount;
 const result=await handleSourceRoutes(new Request(uri),env);assert.equal(result!.status,200);
 const cards=(await result!.json() as any).response.data;assert.equal(cards.length,30);
 assert(queryCount-start<=12,`cold catalog used ${queryCount-start} queries`);
 assert(cards.every((card:any)=>card.manga_cover_image_url.startsWith('https://uploads.mangadex.org/')));
 assert.equal((db.prepare("SELECT count(*) AS n FROM documents WHERE path LIKE 'sourceImages/%'").get() as any).n,1,'only the explicitly seeded legacy image remains');
 const changes=(db.prepare('SELECT total_changes() AS n').get() as any).n;
 await handleSourceRoutes(new Request(uri),env);
 assert.equal((db.prepare('SELECT total_changes() AS n').get() as any).n,changes,'warm browsing is entirely read-only');
});

await check('1200 chapter import uses compact rows and less than 20 queries, repeated sync writes nothing',async()=>{
 const entries=Array.from({length:1200},(_,i)=>({...entry(i+1,true),manga_id:45678,chapter_id:5_000_000+i,slot:String(i+1)}));
 const start=queryCount,changes=Number((db.prepare('SELECT total_changes() AS n').get() as any).n);
 await saveChapterIndex(env.DB,45678,entries);
 assert(queryCount-start<20);
 const written=Number((db.prepare('SELECT total_changes() AS n').get() as any).n)-changes;
 assert(written<300,`expected fewer than 300 changed rows, got ${written}`);
 const stable=Number((db.prepare('SELECT total_changes() AS n').get() as any).n);
 await saveChapterIndex(env.DB,45678,entries);
 assert.equal(Number((db.prepare('SELECT total_changes() AS n').get() as any).n),stable);
 assert.equal((await loadChapterIndex(env.DB,45678)).length,1200);
});

await check('two comments per chapter, shared reply cooldown and deletion free a slot',async()=>{
 const target=987654;
 const create=()=>handleCommentRoutes(new Request(origin+'/manga-app-api/add-chapter-comment',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:`chapter_id=${target}&comment_text=Test+${crypto.randomUUID()}`}),env,claims);
 await put('profiles/author/postGate/shared',{lastAt:1});
 const first=await create();assert.equal(first!.status,200);const id=(await first!.json() as any).response.data.chapter_comment_id;
 const reply=()=>handleCommentRoutes(new Request(origin+'/manga-app-api/add-chapter-comment-reply',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:`chapter_comment_id=${id}&reply_text=Reply+${crypto.randomUUID()}`}),env,claims);
 assert.equal((await reply())!.status,429,'replies share the minute gate');
 await put('profiles/author/postGate/shared',{lastAt:1});assert.equal((await create())!.status,200);
 await put('profiles/author/postGate/shared',{lastAt:1});assert.equal((await create())!.status,409);
 const deletion=await handleCommentRoutes(new Request(origin+'/manga-app-api/delete-chapter-comment?chapter_comment_id='+id,{method:'DELETE'}),env,claims);
 assert.equal(deletion!.status,200);assert.equal((await create())!.status,200,'deleting one frees exactly one comment slot');
});

await check('exhausted source budget preserves saved chapters and reading never writes image mappings',async()=>{
 const day=new Date().toISOString().slice(0,10);
 db.prepare('INSERT INTO source_write_budget(day,reserved) VALUES(?,12000) ON CONFLICT(day) DO UPDATE SET reserved=12000').run(day);
 await put('sourceManga/45678',{remoteId:'budget-title'});
 db.prepare('INSERT INTO source_sync(manga_id,remote_id) VALUES(45678,?)').run('budget-title');
 const before=Number((db.prepare('SELECT total_changes() AS n').get() as any).n);
 const result=await handleSourceRoutes(new Request(origin+'/manga-app-api/get-published-manga-details-info?chapters=true&manga_id=45678'),env);
 assert.equal(result!.status,200);assert.equal((await result!.json() as any).response.data.length,1200);
 assert.equal(Number((db.prepare('SELECT total_changes() AS n').get() as any).n),before);
 globalThis.fetch=async()=>Response.json({result:'ok',baseUrl:'https://uploads.mangadex.org',chapter:{hash:'hash',dataSaver:['one.jpg','two.jpg']}});
 const reader=await handleSourceRoutes(new Request(origin+'/reader/5000000'),env);
 assert.equal(reader!.status,200);const html=await reader!.text();
 assert(html.includes('https://uploads.mangadex.org/data-saver/hash/one.jpg'));
 assert(reader!.headers.get('content-security-policy')?.includes('https://*.mangadex.org'));
 assert.equal(Number((db.prepare('SELECT total_changes() AS n').get() as any).n),before);
});
await check('discussion mode preserves old IDs, imports 1200 numbers into one row and never writes on repeated reads',async()=>{
 db.prepare('UPDATE source_write_budget SET reserved=0').run();
 const discussionEnv={...env,DISCUSSIONS_ONLY:'true'};
 const manga=45678,uri=origin+'/manga-app-api/get-published-manga-details-info?chapters=true&manga_id='+manga;
 let calls=0;
 globalThis.fetch=async(input:any)=>{
  const url=new URL(String(input));calls++;
  assert.equal(url.pathname,'/manga/budget-title/aggregate');assert.equal(url.search,'');
  return Response.json({result:'ok',volumes:{'1':{chapters:Object.fromEntries(Array.from({length:2400},(_,i)=>[i+1,{chapter:String(i+1),id:'unneeded-translation'}]))}}});
 };
 const before=Number((db.prepare('SELECT total_changes() AS n').get() as any).n);
 const originalReaderRows=JSON.stringify(db.prepare('SELECT * FROM source_title_snapshots WHERE manga_id=? ORDER BY part').all(manga));
 const first=await handleSourceRoutes(new Request(uri),discussionEnv);assert.equal(first!.status,200);
 const entries=(await first!.json() as any).response.data;
 assert.equal(entries.length,2400);assert(entries.every((e:any)=>!e.readable && e.chapter_folder_name===''));
 assert.equal(entries.find((e:any)=>e.chapter_number===1).chapter_id,5_000_000);
 assert.equal(Number((db.prepare('SELECT total_changes() AS n').get() as any).n)-before,2,'one budget reservation and one title row for 1200 new numbers');
 assert.equal((db.prepare('SELECT count(*) AS n FROM source_discussion_numbers').get() as any).n,1);
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM source_title_snapshots WHERE manga_id=? ORDER BY part').all(manga)),originalReaderRows);
 const stable=Number((db.prepare('SELECT total_changes() AS n').get() as any).n);
 for(let i=0;i<3;i++) {
  const response=await handleSourceRoutes(new Request(uri),discussionEnv);assert.equal((await response!.json() as any).response.data.length,2400);
 }
 assert.equal(calls,1);assert.equal(Number((db.prepare('SELECT total_changes() AS n').get() as any).n),stable);
 // A fresh isolate, empty provider aggregate, and then a provider outage cannot
 // remove saved numbers or their discussion IDs.
 globalThis.fetch=async()=>Response.json({result:'ok',volumes:{}});
 const empty=await handleSourceRoutes(new Request(uri),{...discussionEnv});
 assert.equal((await empty!.json() as any).response.data.length,2400);
 globalThis.fetch=async()=>{throw new Error('offline');};
 const offline=await handleSourceRoutes(new Request(uri),{...discussionEnv});
 assert.equal((await offline!.json() as any).response.data.length,2400);
 assert.equal((await loadDiscussionNumbers(env.DB,manga)).length,2400);
 assert.equal(Number((db.prepare('SELECT total_changes() AS n').get() as any).n),stable);
});
await check('discussion reader, pages, download and scheduled index do not access the database or provider',async()=>{
 const discussionEnv={...env,DISCUSSIONS_ONLY:'true'},start=queryCount;
 globalThis.fetch=async()=>{throw new Error('Discussion mode must not load pages');};
 const reader=await handleSourceRoutes(new Request(origin+'/reader/5000000'),discussionEnv);
 assert.equal(reader!.status,200);const html=await reader!.text();assert(html.includes('مخصص للنقاش'));assert(!html.includes('<img'));
 const pages=await handleSourceRoutes(new Request(origin+'/manga-app-api/get-published-manga-chapter-pages?chapter_id=5000000'),discussionEnv);
 assert.deepEqual((await pages!.json() as any).response.data,[]);
 const download=await handleSourceRoutes(new Request(origin+'/manga-app-api/download-chapter-as-zip?chapter_id=5000000'),discussionEnv);
 assert.equal(download!.status,403);
 await refreshSourceIndexes(discussionEnv);assert.equal(queryCount,start);
});
await check('discussion mode keeps authenticated comments available and reading them performs no writes',async()=>{
 const discussionEnv={...env,DISCUSSIONS_ONLY:'true'};
 const before=Number((db.prepare('SELECT total_changes() AS n').get() as any).n);
 const response=await handleCommentRoutes(new Request(origin+'/manga-app-api/get-chapter-comments?chapter_id=987654'),discussionEnv,claims);
 assert.equal(response!.status,200);assert.equal((await response!.json() as any).response.data.length,2);
 assert.equal(Number((db.prepare('SELECT total_changes() AS n').get() as any).n),before);
});
globalThis.fetch=realFetch;db.close();console.log(`${passed} profile and chapter checks passed`);
