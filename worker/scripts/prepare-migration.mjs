import {readFileSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
// Run locally only. The input and output contain private user data: never commit.
const [input,output]=process.argv.slice(2);
if(!input||!output) throw new Error('Usage: node scripts/prepare-migration.mjs private-backup.sql private-import.sql');
const db=new DatabaseSync(':memory:');
db.exec(readFileSync(input,'utf8'));
const quote=value=>value===null?'NULL':typeof value==='number'?String(value):"'"+String(value).replaceAll("'","''")+"'";
const sql=[];
for(const file of ['0001_init.sql','0002_comment_indexes.sql','0003_source_index.sql','0004_translation_index.sql','0005_compact_source.sql']) sql.push(readFileSync('migrations/'+file,'utf8'));
const insert=(table,row)=>sql.push(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(quote).join(',')});`);
const titles=new Map(),buckets=new Map(),ids=new Set();
const add=(entry,includeTitle=true)=>{
 ids.add(entry.chapter_id);
 const bucket=entry.chapter_id%256;
 if(!buckets.has(bucket)) buckets.set(bucket,{});
 buckets.get(bucket)[String(entry.chapter_id)]=entry;
 if(!includeTitle)return;
 if(!titles.has(entry.manga_id))titles.set(entry.manga_id,[]);
 titles.get(entry.manga_id).push(entry);
};
for(const row of db.prepare('SELECT payload FROM source_chapter_index').all())add(JSON.parse(row.payload));
let privateDocuments=0,legacyImages=0,orphanMappings=0;
for(const row of db.prepare('SELECT path,fields,updated_at FROM documents').all()) {
 if(row.path.startsWith('sourceChapters/')) {
  const id=Number(row.path.split('/')[1]);if(ids.has(id))continue;
  const fields=JSON.parse(row.fields),read=(key,fallback='')=>fields[key]?.stringValue??fields[key]?.integerValue??fields[key]?.booleanValue??fallback;
  add({slot:'legacy:'+id,chapter_id:id,manga_id:Number(read('mangaId',0)),chapter_number:0,chapter_label:'خاص',chapter_name:'فصل محفوظ',chapter_folder_name:String(read('remoteId')),url:'/reader/'+id,date_upload:0,chapter_watched_history_by_user:'No',readable:read('readable',true)!==false,credits:read('credits'),language:read('language','ar'),alternatives_json:read('alternativesJson','[]')},false);
  orphanMappings++;continue;
 }
 insert('documents',row);
 if(row.path.startsWith('sourceImages/'))legacyImages++;
 else if(!row.path.startsWith('sourceManga/'))privateDocuments++;
}
let partsCount=0;
for(const [manga,entries] of titles) {
 const parts=new Map();
 for(const entry of entries) {const part=entry.chapter_id%16;if(!parts.has(part))parts.set(part,{});parts.get(part)[entry.slot]=entry;}
 for(const [part,payload] of parts) {insert('source_title_snapshots',{manga_id:manga,part,payload:JSON.stringify(payload)});partsCount++;}
 entries.sort((a,b)=>b.chapter_number-a.chapter_number||b.date_upload-a.date_upload);
 insert('source_latest',{manga_id:manga,payload:JSON.stringify(entries[0])});
}
for(const [bucket,payload] of buckets)insert('source_chapter_buckets',{bucket,payload:JSON.stringify(payload)});
for(const row of db.prepare('SELECT * FROM source_sync').all())insert('source_sync',row);
writeFileSync(output,sql.join('\n'));
console.log(JSON.stringify({titles:titles.size,chapters:ids.size,snapshotParts:partsCount,lookupBuckets:buckets.size,privateDocuments,legacyImages,orphanMappings,output},null,2));
db.close();
