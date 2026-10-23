export type ChapterEntry = {
  slot: string;
  chapter_id: number;
  manga_id: number;
  chapter_number: number;
  chapter_label: string;
  chapter_name: string;
  chapter_folder_name: string;
  url: string;
  date_upload: number;
  chapter_watched_history_by_user: string;
  readable: boolean;
  credits: string;
  language?: string;
  alternatives_json?: string;
};

export function chapterSlot(label: unknown): string | null {
  if (typeof label !== "string" || !/^\d+(?:\.\d+)?$/.test(label)) return null;
  const number = Number(label);
  return Number.isFinite(number) && number >= 0 ? String(number) : null;
}

// Numbers and their discussion IDs survive missing upstream results and translation changes.
export function mergeChapterEntries(saved: ChapterEntry[], fresh: ChapterEntry[], refreshTranslations = false): ChapterEntry[] {
  const entries = new Map(saved.map(entry => [entry.slot, entry]));
  for (const entry of fresh) {
    const previous = entries.get(entry.slot);
    const rank = (language?: string) => !language || language === 'ar' ? 0 : language === 'en' ? 1 : 2;
    if (previous && (!entry.readable || previous.readable && !refreshTranslations &&
      (rank(previous.language) < rank(entry.language) || rank(previous.language) === rank(entry.language) && previous.date_upload > entry.date_upload))) continue;
    entries.set(entry.slot, previous ? {...entry, chapter_id: previous.chapter_id, url: previous.url} : entry);
  }
  return [...entries.values()].sort((a, b) => b.chapter_number - a.chapter_number || b.date_upload - a.date_upload);
}

export async function loadChapterIndex(db: D1Database, manga: number): Promise<ChapterEntry[]> {
  const compact = await db.prepare("SELECT payload FROM source_title_snapshots WHERE manga_id=?1").bind(manga).all<{payload: string}>();
  if (compact.results.length) return compact.results.flatMap(row => Object.values(JSON.parse(row.payload) as Record<string, ChapterEntry>))
    .sort((a,b) => b.chapter_number-a.chapter_number || b.date_upload-a.date_upload);
  const result = await db.prepare("SELECT payload FROM source_chapter_index WHERE manga_id=?1 ORDER BY chapter_number DESC")
    .bind(manga).all<{payload: string}>();
  return result.results.map(row => JSON.parse(row.payload) as ChapterEntry);
}

export async function saveChapterIndex(db: D1Database, manga: number, entries: ChapterEntry[]): Promise<void> {
  const previous = await loadChapterIndex(db,manga);
  const merged = mergeChapterEntries(previous,entries,true);
  const before = new Map(previous.map(entry => [entry.slot,JSON.stringify(entry)]));
  const compact = await db.prepare('SELECT 1 AS found FROM source_title_snapshots WHERE manga_id=?1 LIMIT 1').bind(manga).first();
  const changed = compact ? merged.filter(entry => before.get(entry.slot)!==JSON.stringify(entry)) : merged;
  if (!changed.length) return;
  await writeCompactEntries(db,changed,[merged[0]]);
}

export async function writeCompactEntries(db:D1Database,changed:ChapterEntry[],latest:ChapterEntry[]):Promise<void> {
  if(!changed.length) return;
  const parts = new Map<string,{manga:number,part:number,payload:Record<string,ChapterEntry>}>();
  const buckets = new Map<number,Record<string,ChapterEntry>>();
  for (const entry of changed) {
    const part = entry.chapter_id % 16, bucket = entry.chapter_id % 256,key=entry.manga_id+':'+part;
    if (!parts.has(key)) parts.set(key,{manga:entry.manga_id,part,payload:{}});
    if (!buckets.has(bucket)) buckets.set(bucket,{});
    parts.get(key)!.payload[entry.slot]=entry;
    buckets.get(bucket)![String(entry.chapter_id)]=entry;
  }
  // Reserve a conservative upper bound before the atomic batch. Source ingestion
  // can never consume the entire free D1 write allowance; social data has room.
  await reserveSourceWrites(db,parts.size*2+buckets.size+latest.length+3);
  const statements:D1PreparedStatement[]=[];
  // Bulk SQL matters on Free: the entire invocation is limited to 50 queries.
  // Each patch row appears in one bounded JSON parameter, rather than one query
  // per chapter/bucket. JSON patches preserve other titles during concurrent writes.
  for(const values of boundedJson([...parts.values()])) statements.push(db.prepare(`INSERT INTO source_title_snapshots(manga_id,part,payload)
    SELECT json_extract(value,'$.manga'),json_extract(value,'$.part'),json_extract(value,'$.payload') FROM json_each(?1) WHERE 1
    ON CONFLICT(manga_id,part) DO UPDATE SET payload=json_patch(source_title_snapshots.payload,excluded.payload)`).bind(values));
  for(const values of boundedJson([...buckets].map(([bucket,payload])=>({bucket,payload})))) statements.push(db.prepare(`INSERT INTO source_chapter_buckets(bucket,payload)
    SELECT json_extract(value,'$.bucket'),json_extract(value,'$.payload') FROM json_each(?1) WHERE 1
    ON CONFLICT(bucket) DO UPDATE SET payload=json_patch(source_chapter_buckets.payload,excluded.payload)`).bind(values));
  for(const values of boundedJson(latest)) statements.push(db.prepare(`INSERT INTO source_latest(manga_id,payload)
    SELECT json_extract(value,'$.manga_id'),value FROM json_each(?1) WHERE 1
    ON CONFLICT(manga_id) DO UPDATE SET payload=excluded.payload WHERE source_latest.payload != excluded.payload`).bind(values));
  await db.batch(statements);
}

function boundedJson(rows:unknown[]):string[] {
  const chunks:string[]=[];let current:string[]=[],bytes=2;
  for(const row of rows) {
    const value=JSON.stringify(row),length=new TextEncoder().encode(value).length+1;
    if(length>1_500_000)throw new Error('source_snapshot_too_large');
    if(current.length && bytes+length>1_500_000) {chunks.push('['+current.join(',')+']');current=[];bytes=2;}
    current.push(value);bytes+=length;
  }
  if(current.length)chunks.push('['+current.join(',')+']');
  return chunks;
}

export async function reserveSourceWrites(db:D1Database,amount:number):Promise<void> {
  if (amount<1 || amount>12000) throw new Error('source_daily_budget');
  const reserved=await db.prepare(`INSERT INTO source_write_budget(day,reserved) VALUES(?1,?2)
    ON CONFLICT(day) DO UPDATE SET reserved=source_write_budget.reserved+excluded.reserved
    WHERE source_write_budget.reserved+excluded.reserved<=12000 RETURNING reserved`)
    .bind(new Date().toISOString().slice(0,10),amount).first();
  if(!reserved) throw new Error('source_daily_budget');
}

export async function lookupCompactChapter(db:D1Database,id:number):Promise<ChapterEntry|null> {
  const row=await db.prepare('SELECT json_extract(payload,?2) AS entry FROM source_chapter_buckets WHERE bucket=?1')
    .bind(id%256,`$."${id}"`).first<{entry:string|null}>();
  return row?.entry ? JSON.parse(row.entry) as ChapterEntry : null;
}

export function chapterMapping(entry:ChapterEntry):Record<string,unknown> {
  return {localId:entry.chapter_id,mangaId:entry.manga_id,remoteId:entry.chapter_folder_name,credits:entry.credits,
    language:entry.language??'ar',alternativesJson:entry.alternatives_json??'[]',readable:entry.readable};
}
