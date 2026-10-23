import {ChapterEntry, loadChapterIndex, reserveSourceWrites} from './chapter-index';

type Numbers = Record<string, [number, string]>;

export function discussionEntry(manga:number, slot:string, id:number, label:string):ChapterEntry {
  return {slot,chapter_id:id,manga_id:manga,chapter_number:Number(label)||0,chapter_label:label,
    chapter_name:`الفصل ${label}`,chapter_folder_name:'',url:`/reader/${id}`,date_upload:0,
    chapter_watched_history_by_user:'No',readable:false,credits:''};
}

export async function loadDiscussionNumbers(db:D1Database,manga:number):Promise<ChapterEntry[]> {
  const row=await db.prepare('SELECT payload FROM source_discussion_numbers WHERE manga_id=?1').bind(manga).first<{payload:string}>();
  const legacy=await loadChapterIndex(db,manga);
  const entries=new Map(legacy.map(entry=>[entry.slot,discussionEntry(manga,entry.slot,entry.chapter_id,entry.chapter_label)]));
  for(const [slot,[id,label]] of Object.entries(row?JSON.parse(row.payload) as Numbers:{})) {
    if(!entries.has(slot))entries.set(slot,discussionEntry(manga,slot,id,label));
  }
  return [...entries.values()].sort((a,b)=>b.chapter_number-a.chapter_number || a.slot.localeCompare(b.slot));
}

export async function saveNewDiscussionNumbers(db:D1Database,manga:number,saved:ChapterEntry[],fresh:ChapterEntry[]):Promise<void> {
  const known=new Set(saved.map(entry=>entry.slot));
  const patch:Numbers={};
  for(const entry of fresh)if(!known.has(entry.slot))patch[entry.slot]=[entry.chapter_id,entry.chapter_label];
  if(!Object.keys(patch).length)return;
  // One title row, regardless of chapter count; never update reader buckets or
  // persist refresh timestamps. Identical reads therefore have no write cost.
  await reserveSourceWrites(db,3);
  await db.prepare(`INSERT INTO source_discussion_numbers(manga_id,payload) VALUES(?1,?2)
    ON CONFLICT(manga_id) DO UPDATE SET payload=json_patch(excluded.payload,source_discussion_numbers.payload)
    WHERE json_patch(excluded.payload,source_discussion_numbers.payload) != source_discussion_numbers.payload`)
    .bind(manga,JSON.stringify(patch)).run();
}
