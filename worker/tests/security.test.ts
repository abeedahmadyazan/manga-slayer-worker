import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {firestoreRequest,firestoreDocument,Env} from '../src/index';
import {sanitizeAvatar} from '../src/avatar';
import {protectRequest} from '../src/security';

const yes = {limit: async () => ({success:true})};
const no = {limit: async () => ({success:false})};
const env = {REQUEST_LIMITER:yes,CATALOG_LIMITER:yes,DOWNLOAD_LIMITER:yes};
const origin='https://yz-manga-api-v2.yznabyd.workers.dev';
let passed=0;
async function check(name: string, fn:()=>unknown) {await fn();passed++;console.log('PASS',name);}
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
await check('small request preserved',async()=>{
 const result=await protectRequest(new Request(origin+'/manga-app-api/manga-oauth',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'username=test&password=example'}),env);
 assert(result instanceof Request);assert.equal(await result.text(),'username=test&password=example');
});
await check('streamed oversized body rejected without Content-Length',async()=>{
 const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(17000));c.close();}});
 const result=await protectRequest(new Request(origin+'/manga-app-api/add-chapter-comment',{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'} as RequestInit),env);
 assert.equal((result as Response).status,413);
});
await check('forged oversized Content-Length rejected',async()=>{
 const result=await protectRequest(new Request(origin+'/manga-app-api/manga-oauth',{method:'POST',headers:{'content-type':'application/json','content-length':'999999'},body:'{}'}),env);
 assert.equal((result as Response).status,413);
});
await check('unsupported content type rejected',async()=>{
 const result=await protectRequest(new Request(origin+'/manga-app-api/manga-oauth',{method:'POST',headers:{'content-type':'text/plain'},body:'password=test'}),env);
 assert.equal((result as Response).status,415);
});
await check('native empty DELETE stream without Content-Type reaches the authenticated handler',async()=>{
 const stream=new ReadableStream({start(controller){controller.close();}});
 const request=new Request(origin+'/manga-app-api/delete-chapter-comment?chapter_comment_id=123',{
  method:'DELETE',headers:{'content-length':'0'},body:stream,duplex:'half'
 } as RequestInit);
 const result=await protectRequest(request,env);
 assert(result instanceof Request);assert.equal(result.method,'DELETE');assert.equal(await result.text(),'');
 assert.equal(new URL(result.url).searchParams.get('chapter_comment_id'),'123');
});
await check('declared empty DELETE cannot bypass MIME validation with a nonempty stream',async()=>{
 const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('untyped body'));controller.close();}});
 const result=await protectRequest(new Request(origin+'/manga-app-api/delete-chapter-comment',{
  method:'DELETE',headers:{'content-length':'0'},body:stream,duplex:'half'
 } as RequestInit),env);
 assert.equal((result as Response).status,415);
});
await check('edge, catalog and download limits enforced',async()=>{
 for(const [path,bindings] of [['/health',{...env,REQUEST_LIMITER:no}],['/reader/123',{...env,CATALOG_LIMITER:no}],['/manga-app-api/download-chapter-as-zip',{...env,DOWNLOAD_LIMITER:no}]] as const){
  const r=await protectRequest(new Request(origin+path),bindings);assert.equal((r as Response).status,429);
 }
});
await check('cleartext remote requests rejected',async()=>{
 assert.equal((await protectRequest(new Request('http://example.org/health'),env) as Response).status,400);
});
await check('valid PNG preserved',()=>assert.deepEqual(sanitizeAvatar(png,'image/png'),png));
await check('metadata stripped from PNG',()=>{
 const metadata=Uint8Array.from([0,0,0,6,116,69,88,116,71,80,83,61,49,50,0,0,0,0]);
 const input=Uint8Array.from([...png.slice(0,33),...metadata,...png.slice(33)]);
 assert.deepEqual(sanitizeAvatar(input,'image/png'),png);
});
await check('oversized dimensions rejected',()=>{
 const input=png.slice();new DataView(input.buffer).setUint32(16,99999);assert.throws(()=>sanitizeAvatar(input,'image/png'));
});
await check('truncated and disguised image rejected',()=>{
 assert.throws(()=>sanitizeAvatar(png.slice(0,40),'image/png'));assert.throws(()=>sanitizeAvatar(new TextEncoder().encode('<svg onload="alert(1)">'),'image/png'));
});
await check('JPEG and WebP metadata removed without breaking images',()=>{
 for(const [file,type] of [['avatar.jpg','image/jpeg'],['avatar.webp','image/webp']]){
  const input=new Uint8Array(readFileSync('tests/fixtures/'+file));
  const output=sanitizeAvatar(input,type);assert(output.length<input.length);assert(!Buffer.from(output).includes(Buffer.from('private-metadata-example')));
  writeFileSync('.wrangler/'+file,output);
 }
});
await check('stale writes cannot overwrite or resurrect deleted comments',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(readFileSync('migrations/0001_init.sql','utf8'));
 class Statement {
  args: any[]=[];
  constructor(public sql:string){}
  bind(...args:any[]){this.args=args;return this;}
  async first(){return db.prepare(this.sql).get(...this.args)??null;}
  async all(){return {results:db.prepare(this.sql).all(...this.args)};}
  async run(){db.prepare(this.sql).run(...this.args);return {success:true};}
 }
 const store={prepare:(sql:string)=>new Statement(sql),batch:async (statements:Statement[])=>{
  db.exec('BEGIN');try{for(const stmt of statements)await stmt.run();db.exec('COMMIT');return [];}catch(e){db.exec('ROLLBACK');throw e;}
 }};
 const bindings={...env,DB:store,FIREBASE_PROJECT_ID:'test'} as unknown as Env;
 const name='projects/test/databases/(default)/documents/comments/1';
 const patch=(path:string,text:string)=>firestoreRequest(bindings,path,{method:'PATCH',body:JSON.stringify(firestoreDocument(name,{text}))});
 assert.equal((await patch('/comments/1','first')).status,200);
 assert.equal((await patch('/comments/1?currentDocument.updateTime=1&updateMask.fieldPaths=text','second')).status,200);
 assert.equal((await patch('/comments/1?currentDocument.updateTime=1&updateMask.fieldPaths=text','stale')).status,409);
 const commit=(version:string)=>firestoreRequest(bindings,':commit',{method:'POST',body:JSON.stringify({writes:[{delete:name,currentDocument:{updateTime:version}}]})});
 assert.equal((await commit('1')).status,409);
 assert.equal((await commit('2')).status,200);
 assert.equal((await patch('/comments/1?currentDocument.updateTime=2&updateMask.fieldPaths=text','resurrect')).status,409);
 assert.equal((await firestoreRequest(bindings,'/comments/1')).status,404);db.close();
});
console.log(`${passed} security checks passed`);
