import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const [beforeFile,afterFile]=process.argv.slice(2);
const before=new DatabaseSync(':memory:'),after=new DatabaseSync(':memory:');
before.exec(readFileSync(beforeFile,'utf8'));after.exec(readFileSync(afterFile,'utf8'));
let documents=0,chapters=0;
for(const row of before.prepare('SELECT * FROM documents').all()) {
 if(row.path.startsWith('sourceChapters/')) {
  const id=Number(row.path.split('/')[1]);
  const found=after.prepare('SELECT json_extract(payload,?) AS entry FROM source_chapter_buckets WHERE bucket=?').get(`$."${id}"`,id%256);
  assert(found?.entry,'Missing chapter mapping');chapters++;
 } else {
  assert.deepEqual(after.prepare('SELECT * FROM documents WHERE path=?').get(row.path),row,'Document changed during migration');documents++;
 }
}
let largest=0;
for(const table of ['source_title_snapshots','source_chapter_buckets']) {
 largest=Math.max(largest,Number(after.prepare(`SELECT max(length(CAST(payload AS BLOB))) AS n FROM ${table}`).get().n));
}
assert(largest<2_000_000,'D1 row size exceeded');
console.log(JSON.stringify({preservedDocuments:documents,preservedChapterMappings:chapters,largestCompactRowBytes:largest,verified:true}));
before.close();after.close();
