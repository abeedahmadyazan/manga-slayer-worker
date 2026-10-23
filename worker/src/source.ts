import {translationCandidates, languageName, aggregateSlot} from "./translations";
import { ChapterEntry, chapterSlot, mergeChapterEntries, loadChapterIndex, saveChapterIndex, writeCompactEntries, lookupCompactChapter, reserveSourceWrites } from "./chapter-index";
import { Env, firestoreDocument, firestoreRequest, firestoreValue, jsonResponse } from "./index";
import { FirebaseClaims } from "./index";
import { publicSourceCache } from "./public-cache";
import {discussionEntry,loadDiscussionNumbers,saveNewDiscussionNumbers} from './discussion-numbers';

type Dict = Record<string, unknown>;
const encoder = new TextEncoder();
const API = "https://api.mangadex.org";
const SAFE_HOSTS = ["mangadex.org", "mangadex.network"];
const TRANSLATION_VERSION = 2;
const discussionsOnly = (env:Env) => env.DISCUSSIONS_ONLY === 'true';
class SourceHttpError extends Error {
  constructor(public status: number) { super("mangadex_unavailable"); }
}
const TAG_NAMES: Record<string, string> = {
  Action: "أكشن", Adventure: "مغامرة", Comedy: "كوميديا", Drama: "دراما", Fantasy: "فانتازيا",
  Horror: "رعب", Mystery: "غموض", Romance: "رومانسي", "Sci-Fi": "خيال علمي", "Slice of Life": "شريحة من الحياة",
  Sports: "رياضة", Supernatural: "خوارق", Thriller: "إثارة", Tragedy: "مأساة", Isekai: "عالم آخر",
};

function response(data: unknown): Response { return jsonResponse({ response: data }); }
function collection(data: unknown[], params: URLSearchParams, total = data.length): Response {
  const limit = Math.min(100, Math.max(1, Number(params.get("_limit") ?? params.get("limit") ?? 30) || 30));
  const offset = Math.max(0, Number(params.get("_offset") ?? params.get("offset") ?? 0) || 0);
  return response({ data, total, meta_data: { _limit: limit, _offset: offset, _order_by: params.get("_order_by") ?? "id desc" } });
}
function error(status: number, message: string): Response { return jsonResponse({ message, error: message }, status); }
function int(value: unknown, fallback = 0): number { const n = Number(value); return Number.isSafeInteger(n) ? n : fallback; }

async function hashId(text: string): Promise<number> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + digest[i];
  return n + 1_000_000;
}

async function upsertDoc(env: Env, path: string, data: Dict): Promise<void> {
  const name = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const result = await firestoreRequest(env, `/${path}`, { method: "PATCH", body: JSON.stringify(firestoreDocument(name, data)) });
  if (!result.ok) throw new Error("store_failed");
}

async function getDoc(env: Env, path: string): Promise<Dict | null> {
  const result = await firestoreRequest(env, `/${path}`);
  if (result.status === 404) return null;
  if (!result.ok) throw new Error("store_failed");
  const doc = await result.json() as { fields?: Record<string, Dict> };
  const out: Dict = {};
  for (const [key, field] of Object.entries(doc.fields ?? {})) {
    if ("stringValue" in field) out[key] = field.stringValue;
    else if ("integerValue" in field) out[key] = Number(field.integerValue);
    else if ("booleanValue" in field) out[key] = field.booleanValue;
    else if ("doubleValue" in field) out[key] = field.doubleValue;
    else if ("nullValue" in field) out[key] = null;
  }
  return out;
}

async function mangaId(env: Env, uuid: string): Promise<number> {
  const id = await hashId(`manga:${uuid}`);
  const existing = await getDoc(env, `sourceManga/${id}`);
  if (existing && existing.remoteId !== uuid) throw new Error("source_id_collision");
  if (!existing) {
    await reserveSourceWrites(env.DB,5);
    await upsertDoc(env, `sourceManga/${id}`, { localId: id, remoteId: uuid, createdAt: new Date().toISOString() });
  }
  return id;
}

async function chapterId(env: Env, uuid: string, manga: number, credits: string): Promise<number> {
  const id = await hashId(`chapter:${uuid}`);
  const existing = await getDoc(env, `sourceChapters/${id}`);
  if (existing && existing.remoteId !== uuid) throw new Error("source_id_collision");
  if (!existing || existing.credits !== credits) await upsertDoc(env, `sourceChapters/${id}`, { localId: id, remoteId: uuid, mangaId: manga, credits, createdAt: existing?.createdAt ?? new Date().toISOString() });
  return id;
}

async function imageUrl(env: Env, url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !SAFE_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) throw new Error("untrusted_image_host");
  // Public page bytes go from the image CDN directly to the phone: no database
  // mappings, no Worker request per page, and no copied image files on GitHub.
  if(parsed.username || parsed.password || parsed.port && parsed.port !== '443') throw new Error('untrusted_image_host');
  return parsed.toString();
}

async function mangaDex(path: string, params?: URLSearchParams): Promise<Dict> {
  const url = `${API}${path}${params && params.size ? `?${params.toString()}` : ""}`;
  const result = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "YZ-Manga/1.0 (personal reader)" },
    signal: AbortSignal.timeout(18_000),
  });
  if (!result.ok) throw new SourceHttpError(result.status);
  const json = await result.json() as Dict;
  if (json.result !== "ok") throw new Error("mangadex_invalid_response");
  return json;
}

function titleOf(attributes: Dict): string {
  const title = attributes.title as Dict | undefined;
  const alts = attributes.altTitles as Dict[] | undefined;
  const arabic = alts?.find((item) => typeof item.ar === "string")?.ar;
  return String(title?.ar ?? arabic ?? title?.en ?? title?.["ja-ro"] ?? Object.values(title ?? {})[0] ?? "مانجا");
}

async function convertManga(env: Env, item: Dict, origin: string, knownId?:number): Promise<Dict> {
  const id = knownId ?? await mangaId(env, String(item.id));
  const attributes = item.attributes as Dict;
  const relationships = (item.relationships as Dict[] | undefined) ?? [];
  const cover = relationships.find((relationship) => relationship.type === "cover_art") as Dict | undefined;
  const filename = (cover?.attributes as Dict | undefined)?.fileName;
  const coverUrl = filename ? await imageUrl(env, `https://uploads.mangadex.org/covers/${item.id}/${filename}.256.jpg`) : "/media/cover.png";
  const names = relationships.filter((relationship) => relationship.type === "author").map((relationship) => String((relationship.attributes as Dict | undefined)?.name ?? "")).filter(Boolean);
  const descriptions = attributes.description as Dict | undefined;
  const description = String(descriptions?.ar ?? descriptions?.en ?? "");
  const tags = (attributes.tags as Dict[] | undefined) ?? [];
  const genres = tags.map((tag) => {
    const a = tag.attributes as Dict;
    const name = (a.name as Dict | undefined)?.en;
    return TAG_NAMES[String(name)] ?? String(name ?? "");
  }).filter(Boolean).join(", ");
  const status = attributes.status === "completed" ? "Completed" : "Ongoing";
  return {
    manga_id: id,
    manga_name: titleOf(attributes),
    url: `/manga/${id}`,
    manga_cover_image_url: new URL(coverUrl, origin).toString(),
    manga_cover_image: "",
    manga_description: description,
    description,
    author: names.join(", "),
    artist: "",
    genre: genres,
    manga_genres: genres,
    manga_genre_ids: tags.map((tag) => String(tag.id)).join(","),
    manga_theater: "مانجا",
    manga_theater_id: "1",
    manga_status: status,
    status: status === "Completed" ? 2 : 1,
    manga_folder_name: String(item.id),
    manga_age_rating: "0",
    manga_rank: "0",
    manga_rating: "0",
    manga_rating_user_count: "0",
    manga_rating_by_user: "0",
    manga_rated_by_user: "0",
    manga_published: "1",
    manga_featured: "0",
    manga_release_date: String(attributes.year ?? ""),
    manga_updated_at: String(attributes.updatedAt ?? "").replace("T", " ").replace("Z", ""),
    latest_chapter_id: "0",
    latest_chapter_name: "عرض الفصول",
    related_manga: {},
    related_recommendations: {},
    initialized: true,
  };
}

async function listManga(env: Env, url: URL, origin: string, claims?: FirebaseClaims): Promise<Response> {
  const q = url.searchParams;
  const limit = Math.min(30, Math.max(1, int(q.get("limit") ?? q.get("_limit"), 30)));
  const offset = Math.max(0, int(q.get("offset") ?? q.get("_offset")));
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  params.append("availableTranslatedLanguage[]", "ar");
  params.set("hasAvailableChapters", "true");
  params.append("includes[]", "cover_art");
  params.append("includes[]", "author");
  params.append("contentRating[]", "safe");
  params.append("contentRating[]", "suggestive");
  const search = q.get("search") ?? q.get("_search") ?? q.get("query") ?? q.get("manga_name") ?? "";
  if (search) params.set("title", search);
  const status = (q.get("manga_status") ?? "").toLowerCase();
  if (["ongoing", "completed", "hiatus", "cancelled"].includes(status)) params.append("status[]", status);
  if ((q.get("list_type") ?? "").toLowerCase().includes("currently")) params.append("status[]", "ongoing");
  const orderKey = q.get("sort_by") === "manga_name" ? "title" : (q.get("list_type") ?? "").includes("top") ? "followedCount" : "latestUploadedChapter";
  params.set(`order[${orderKey}]`, q.get("sort_by") === "manga_name" && q.get("sort_by_direction") === "ASC" ? "asc" : "desc");
  for (const value of q.getAll("genre_include_ids")) {
    for (const id of value.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/gi) ?? []) params.append("includedTags[]", id);
  }
  const listType = (q.get("list_type") ?? q.get("arg_list_type") ?? "").toLowerCase().replaceAll("_", "-");
  const userList = ["favorites", "plan-to-watch", "watching", "watched", "dropped"].find((key) => listType.includes(key));
  if (userList && !claims) return error(401, "سجّل الدخول أولاً.");
  if (userList && claims) {
    const prefix = `profiles/${claims.sub}/library/${userList}_`;
    const result = await env.DB.prepare("SELECT fields FROM documents WHERE path >= ?1 AND path < ?2 ORDER BY updated_at DESC LIMIT ?3 OFFSET ?4").bind(prefix, prefix + "\uffff", limit, offset).all<{fields: string}>();
    const count = await env.DB.prepare("SELECT count(*) AS total FROM documents WHERE path >= ?1 AND path < ?2").bind(prefix, prefix + "\uffff").first<{total: number}>();
    const paths=result.results.map(row=>'sourceManga/'+Number(JSON.parse(row.fields).mangaId.integerValue));
    const mappings=paths.length?await env.DB.prepare(`SELECT path,fields FROM documents WHERE path IN (${paths.map((_,i)=>'?'+(i+1)).join(',')})`).bind(...paths).all<{path:string,fields:string}>():{results:[]};
    const saved = await mapLimited(mappings.results,async row => {
      const remoteId=String(JSON.parse(row.fields).remoteId.stringValue);
      const remote = await cachedMangaDex(env, `/manga/${encodeURIComponent(remoteId)}?includes[]=cover_art&includes[]=author`);
      return remote.data as Dict;
    });
    return collection(await catalogCards(env,saved,origin), q, count?.total ?? 0);
  }
  const remote = await cachedMangaDex(env, "/manga", params);
  const items=await catalogCards(env,(remote.data as Dict[])??[],origin);
  return collection(items, q, int(remote.total, items.length));
}

async function catalogCards(env:Env,items:Dict[],origin:string):Promise<Dict[]> {
  if(!items.length)return [];
  const ids=await Promise.all(items.map(item=>hashId(`manga:${item.id}`)));
  const paths=ids.map(id=>'sourceManga/'+id);
  const known=await env.DB.prepare(`SELECT path,fields FROM documents WHERE path IN (${paths.map((_,i)=>'?'+(i+1)).join(',')})`).bind(...paths).all<{path:string,fields:string}>();
  const byPath=new Map(known.results.map(row=>[row.path,JSON.parse(row.fields).remoteId.stringValue]));
  const pending=items.flatMap((item,i)=>{
    const existing=byPath.get(paths[i]);
    if(existing && existing!==item.id)throw new Error('source_id_collision');
    return existing?[]:[{path:paths[i],fields:firestoreDocument('',{localId:ids[i],remoteId:item.id}).fields}];
  });
  if(pending.length) {
    await reserveSourceWrites(env.DB,pending.length*4+1);
    await env.DB.prepare(`INSERT INTO documents(path,fields,updated_at)
      SELECT json_extract(value,'$.path'),json_extract(value,'$.fields'),1 FROM json_each(?1) WHERE 1 ON CONFLICT(path) DO NOTHING`).bind(JSON.stringify(pending)).run();
  }
  const latestRows=await env.DB.prepare(`SELECT manga_id,payload FROM source_latest WHERE manga_id IN (${ids.map((_,i)=>'?'+(i+1)).join(',')})`).bind(...ids).all<{manga_id:number,payload:string}>();
  const latest=new Map(latestRows.results.map(row=>[row.manga_id,JSON.parse(row.payload) as ChapterEntry]));
  const uploaded=[...new Set(items.map(item=>String((item.attributes as Dict).latestUploadedChapter??'')).filter(Boolean))];
  const versions=new Map<string,Dict>();
  if(uploaded.length) {
    const params=new URLSearchParams({limit:'100',includeUnavailable:'0',includeEmptyPages:'0',includeExternalUrl:'0'});
    for(const id of uploaded)params.append('ids[]',id);
    try {for(const chapter of ((await cachedMangaDex(env,'/chapter',params)).data as Dict[])??[])versions.set(String(chapter.id),chapter);} catch(cause) {if(!latest.size)throw cause;}
  }
  const changed:ChapterEntry[]=[],cards:Dict[]=[];
  for(const [i,item] of items.entries()) {
    const id=ids[i],previous=latest.get(id),chapter=versions.get(String((item.attributes as Dict).latestUploadedChapter)),a=chapter?.attributes as Dict|undefined;
    let current=previous;
    const label=chapterSlot(String(a?.chapter??''));
    if(chapter && a && label!==null && !a.isUnavailable && !a.externalUrl && Number(a.pages)>0 && (!previous || Number(label)>previous.chapter_number)) {
      const cid=await hashId(`chapter-slot:${id}:${label}`),language=String(a.translatedLanguage??'');
      current={slot:label,chapter_id:cid,manga_id:id,chapter_number:Number(label),chapter_label:label,chapter_name:`الفصل ${label} [${languageName(language)}]`,chapter_folder_name:String(chapter.id),url:'/reader/'+cid,date_upload:Date.parse(String(a.readableAt??''))||0,chapter_watched_history_by_user:'No',readable:true,credits:'',language};
      changed.push(current);
    }
    if(current)cards.push({...await convertManga(env,item,origin,id),latest_chapter_id:String(current.chapter_id),latest_chapter_name:`الفصل ${current.chapter_label}`});
  }
  if(changed.length && !discussionsOnly(env))await writeCompactEntries(env.DB,changed,changed);
  // Discussion mode derives stable IDs from numbers. Browsing the catalog must
  // not create per-chapter reader mappings or update latest-number rows.
  return cards;
}

type SyncState = { manga_id: number; remote_id: string; chapter_count: number; synced_at: number; arabic_synced_at: number; retry_after: number; lease_until: number; manga_json: string | null; translation_version: number };
const INDEX_TTL = 6 * 60 * 60;

async function syncState(env: Env, manga: number): Promise<SyncState | null> {
  return env.DB.prepare("SELECT * FROM source_sync WHERE manga_id=?1").bind(manga).first<SyncState>();
}

async function rememberManga(env: Env, item: Dict): Promise<void> {
  const current=await syncState(env,Number(item.manga_id));
  if(current?.manga_json===JSON.stringify(item)) return;
  await reserveSourceWrites(env.DB,4);
  await env.DB.prepare("INSERT INTO source_sync(manga_id,remote_id,manga_json,last_accessed_at) VALUES(?1,?2,?3,?4) ON CONFLICT(manga_id) DO UPDATE SET manga_json=excluded.manga_json,last_accessed_at=excluded.last_accessed_at WHERE source_sync.manga_json IS NOT excluded.manga_json OR source_sync.last_accessed_at < excluded.last_accessed_at-3600")
    .bind(item.manga_id, item.manga_folder_name, JSON.stringify(item), Math.floor(Date.now()/1000)).run();
}

async function chapters(env: Env, manga: number, remoteId: string, origin: string, arabic = true, force = false): Promise<ChapterEntry[]> {
  if(discussionsOnly(env))return discussionChapters(env,manga,remoteId);
  let saved = await loadChapterIndex(env.DB, manga);
  const now = Math.floor(Date.now()/1000);
  let state = await syncState(env, manga);
  if(!state) {
    await reserveSourceWrites(env.DB,4);
    await env.DB.prepare("INSERT INTO source_sync(manga_id,remote_id,last_accessed_at) VALUES(?1,?2,?3) ON CONFLICT(manga_id) DO NOTHING").bind(manga, remoteId, now).run();
    state=await syncState(env,manga);
  }
  if (!state?.synced_at && !arabic) {
    const legacy = await env.DB.prepare("SELECT 1 FROM documents WHERE path GLOB 'sourceChapters/[0-9]*' AND CAST(json_extract(fields,'$.mangaId.integerValue') AS INTEGER)=?1 AND json_extract(fields,'$.remoteId.stringValue') != '' LIMIT 1").bind(manga).first();
    if (legacy) arabic = true;
  }
  const checkedAt = arabic ? (state?.translation_version === TRANSLATION_VERSION ? state.arabic_synced_at : 0) : state?.synced_at;
  if ((!force && checkedAt && now - checkedAt < INDEX_TTL) || (state?.retry_after ?? 0) > now) return saved;
  let lease:unknown;
  try {
    await reserveSourceWrites(env.DB,10);
    lease = await env.DB.prepare("UPDATE source_sync SET lease_until=?2 WHERE manga_id=?1 AND lease_until < ?3 RETURNING manga_id").bind(manga, now+120, now).first();
  } catch(cause) { if(saved.length) return saved; throw cause; }
  if (!lease) return saved;
  try {
    saved = await loadChapterIndex(env.DB, manga);
    const incoming: ChapterEntry[] = [];
    // A published number is a permanent discussion slot, even without Arabic pages.
    const aggregate = await mangaDex(`/manga/${encodeURIComponent(remoteId)}/aggregate`);
    for (const volume of Object.values((aggregate.volumes ?? {}) as Dict)) {
      for (const raw of Object.values(((volume as Dict).chapters ?? {}) as Dict)) {
        const label = chapterSlot(String((raw as Dict).chapter ?? "")) ?? "خاص";
        const slot = aggregateSlot(raw as Dict);
        if (slot === null) continue;
        const id = await hashId(`chapter-slot:${manga}:${slot}`);
        incoming.push({slot, chapter_id:id, manga_id:manga, chapter_number:Number(chapterSlot(label) ?? 0), chapter_label:label,
          chapter_name:`الفصل ${label}`, chapter_folder_name:"", url:`/reader/${id}`, date_upload:0,
          chapter_watched_history_by_user:"No", readable:false, credits:""});
      }
    }
    if (arabic) {
      const [arAggregate,enAggregate] = await Promise.all([
        mangaDex(`/manga/${encodeURIComponent(remoteId)}/aggregate`,new URLSearchParams({"translatedLanguage[]":"ar"})),
        mangaDex(`/manga/${encodeURIComponent(remoteId)}/aggregate`,new URLSearchParams({"translatedLanguage[]":"en"})),
      ]);
      const candidates = translationCandidates([arAggregate,enAggregate,aggregate]);
      const unresolved = new Map(candidates);
      // Resolve only the preferred version per number, not every duplicate translation upload.
      // Retry alternate uploads when a candidate has no usable pages; all numbers remain saved.
      for(let attempt=0;attempt<3 && unresolved.size;attempt++) {
        const ids = [...new Set([...unresolved.values()].map(values=>values[attempt]).filter((id):id is string=>Boolean(id)))];
        if(!ids.length) break;
        const batches:string[][]=[];
        for(let offset=0;offset<ids.length;offset+=100) batches.push(ids.slice(offset,offset+100));
        const metadata = await mapLimited(batches,async batch=>{
          const params=new URLSearchParams({limit:"100",includeUnavailable:"0",includeEmptyPages:"0",includeExternalUrl:"0"});
          params.append("includes[]","scanlation_group");
          for(const id of batch) params.append("ids[]",id);
          return ((await mangaDex("/chapter",params)).data as Dict[]) ?? [];
        });
        const byId = new Map(metadata.flat().map(item=>[String(item.id),item]));
        for(const [slot,choices] of unresolved) {
          const item=byId.get(choices[attempt]);
          if(!item) continue;
          const a=item.attributes as Dict;
          if(a.isUnavailable || a.externalUrl || !a.pages || Date.parse(String(a.publishAt ?? "")) > Date.now()) continue;
          const label=String(a.chapter ?? "خاص"), language=String(a.translatedLanguage ?? "");
          const id=await hashId(`chapter:${item.id}`);
          const groups=((item.relationships as Dict[]) ?? []).filter(r=>r.type==="scanlation_group").map(r=>String((r.attributes as Dict | undefined)?.name ?? "")).filter(Boolean).join(", ");
          incoming.push({slot,chapter_id:id,manga_id:manga,chapter_number:Number(chapterSlot(label) ?? 0),chapter_label:label,
            chapter_name:`الفصل ${label}${a.title ? ` — ${a.title}` : ""} [${languageName(language)}]`,chapter_folder_name:String(item.id),url:`/reader/${id}`,
            date_upload:Date.parse(String(a.readableAt ?? "")) || 0,chapter_watched_history_by_user:"No",readable:true,credits:groups,language,alternatives_json:JSON.stringify(choices.slice(0,8))});
          unresolved.delete(slot);
        }
      }
    }
    // Prefer the pre-existing Arabic discussion ID for the initial import.
    const fresh = mergeChapterEntries([], incoming.filter(e=>e.readable).concat(incoming.filter(e=>!e.readable)));
    saved = mergeChapterEntries(saved, fresh, arabic);
    await saveChapterIndex(env.DB, manga, saved);
    await env.DB.prepare("UPDATE source_sync SET chapter_count=?2,synced_at=?3,arabic_synced_at=CASE WHEN ?4 THEN ?3 ELSE arabic_synced_at END,translation_version=CASE WHEN ?4 THEN ?5 ELSE translation_version END,retry_after=0,lease_until=0 WHERE manga_id=?1")
      .bind(manga,saved.length,now,arabic ? 1 : 0,TRANSLATION_VERSION).run();
    return saved;
  } catch (error) {
    try { await env.DB.prepare("UPDATE source_sync SET retry_after=?2,lease_until=0 WHERE manga_id=?1").bind(manga,now+1800).run(); } catch { /* serving the saved index does not require a write */ }
    if (saved.length) return saved;
    throw error;
  }
}

async function discussionChapters(env:Env,manga:number,remoteId:string):Promise<ChapterEntry[]> {
  const saved=await loadDiscussionNumbers(env.DB,manga);
  try {
    const aggregate=await publicSourceCache(env,`discussion-numbers-v1:${remoteId}`,
      ()=>mangaDex(`/manga/${encodeURIComponent(remoteId)}/aggregate`),INDEX_TTL);
    const bySlot=new Map(saved.map(entry=>[entry.slot,entry]));
    const fresh:ChapterEntry[]=[];
    for(const volume of Object.values((aggregate.volumes??{}) as Dict)) {
      for(const raw of Object.values(((volume as Dict).chapters??{}) as Dict)) {
        const slot=aggregateSlot(raw as Dict);
        if(slot===null || bySlot.has(slot))continue;
        const label=chapterSlot(String((raw as Dict).chapter??''))??'خاص';
        const entry=discussionEntry(manga,slot,await hashId(`chapter-slot:${manga}:${slot}`),label);
        bySlot.set(slot,entry);fresh.push(entry);
      }
    }
    await saveNewDiscussionNumbers(env.DB,manga,saved,fresh);
    return [...bySlot.values()].sort((a,b)=>b.chapter_number-a.chapter_number || a.slot.localeCompare(b.slot));
  } catch(cause) {
    if(saved.length)return saved;
    throw cause;
  }
}

async function indexedManga(env: Env, item: Dict, origin: string): Promise<Dict | null> {
  const manga = Number(item.manga_id);
  const stored = await env.DB.prepare('SELECT payload FROM source_latest WHERE manga_id=?1')
    .bind(manga).first<{payload:string}>() ?? await env.DB.prepare('SELECT payload FROM source_chapter_index WHERE manga_id=?1 ORDER BY chapter_number DESC LIMIT 1').bind(manga).first<{payload:string}>();
  let latest = stored ? JSON.parse(stored.payload) as ChapterEntry : undefined;
  // Catalog cards only need the latest number. Importing ALL numbers for every
  // title shown in a list exhausted D1 writes before those titles were opened.
  // Keep a usable discussion slot for the latest number; full indexing is lazy.
  try {
    const aggregate = await cachedMangaDex(env, `/manga/${encodeURIComponent(String(item.manga_folder_name))}/aggregate`);
    for (const volume of Object.values((aggregate.volumes ?? {}) as Dict)) {
      for (const raw of Object.values(((volume as Dict).chapters ?? {}) as Dict)) {
        const label = chapterSlot(String((raw as Dict).chapter ?? ''));
        const slot = aggregateSlot(raw as Dict);
        if (slot === null || latest && (label === null || Number(label) <= latest.chapter_number)) continue;
        const id = await hashId(`chapter-slot:${manga}:${slot}`);
        latest = {slot,chapter_id:id,manga_id:manga,chapter_number:Number(label ?? 0),chapter_label:label ?? 'خاص',
          chapter_name:`الفصل ${label ?? 'خاص'}`,chapter_folder_name:'',url:`/reader/${id}`,date_upload:0,
          chapter_watched_history_by_user:'No',readable:false,credits:''};
      }
    }
  } catch (cause) { if (!latest) throw cause; }
  if (!latest) return null;
  if (!stored || (JSON.parse(stored.payload) as ChapterEntry).chapter_id !== latest.chapter_id) {
    await saveChapterIndex(env.DB,manga,[latest]);
  }
  return {...item,latest_chapter_id:String(latest.chapter_id),latest_chapter_name:`الفصل ${latest.chapter_label}`};
}

async function cachedMangaDex(env: Env, path: string, params?: URLSearchParams): Promise<Dict> {
  const key = path + "?" + (params?.toString() ?? "");
  return publicSourceCache(env,key,()=>mangaDex(path,params),path.startsWith('/at-home/')?60:900);
}

async function mapLimited<T,R>(values:T[],fn:(value:T)=>Promise<R>):Promise<R[]> {
  const output:R[] = new Array(values.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(3,values.length)},async()=>{while(cursor<values.length){const i=cursor++;output[i]=await fn(values[i]);}}));
  return output;
}

export async function refreshSourceIndexes(env: Env): Promise<void> {
  if(discussionsOnly(env))return;
  const now=Math.floor(Date.now()/1000);
  const rows=await env.DB.prepare("SELECT * FROM source_sync WHERE arabic_synced_at > 0 AND (synced_at < ?1 OR arabic_synced_at < ?1 OR translation_version < ?3) AND retry_after < ?2 ORDER BY synced_at ASC LIMIT 1")
    .bind(now-INDEX_TTL,now,TRANSLATION_VERSION).all<SyncState>();
  for(const row of rows.results) {try{await chapters(env,row.manga_id,row.remote_id,"",true,true);}catch{console.error("chapter_sync_failed",row.manga_id);}}
}

async function chapterPages(env: Env, chapterLocalId: number, origin: string): Promise<Dict[]> {
  const assets = await chapterAssets(env, chapterLocalId);
  const result: Dict[] = [];
  for (const asset of assets) {
    const path = await imageUrl(env, asset.url);
    result.push({ index: asset.index, url: "", page_image_url: new URL(path, origin).toString() });
  }
  return result;
}

async function chapterAssets(env: Env, chapterLocalId: number): Promise<{ index: number; url: string; filename: string }[]> {
  const mapping = await getDoc(env, `sourceChapters/${chapterLocalId}`);
  if (!mapping) throw new Error("chapter_not_found");
  if (mapping.readable === false) throw new Error("chapter_not_readable");
  let alternatives: unknown = [];
  try { alternatives = JSON.parse(String(mapping.alternativesJson ?? "[]")); } catch { /* use preferred version */ }
  const choices = [...new Set([String(mapping.remoteId), ...(Array.isArray(alternatives) ? alternatives.filter(id=>typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id)) : [])])].slice(0,6);
  let response: Dict | undefined;
  for (const candidate of choices) {
    try {
      const value = await cachedMangaDex(env,`/at-home/server/${encodeURIComponent(candidate)}`);
      const data = value.chapter as Dict | undefined;
      if (!data || !((data.dataSaver as unknown[] | undefined)?.length || (data.data as unknown[] | undefined)?.length)) continue;
      response = value;
      if (candidate !== mapping.remoteId) {
        const metadata = (await mangaDex(`/chapter/${encodeURIComponent(candidate)}?includes[]=scanlation_group`)).data as Dict;
        const attrs = metadata.attributes as Dict;
        const language = String(attrs.translatedLanguage ?? "");
        const credits = ((metadata.relationships as Dict[]) ?? []).filter(r=>r.type === "scanlation_group").map(r=>String((r.attributes as Dict | undefined)?.name ?? "")).filter(Boolean).join(", ");
        const entry = await lookupCompactChapter(env.DB,chapterLocalId);
        if(entry) {
          const updated = {...entry,chapter_folder_name:candidate,language,credits,
            chapter_name:`الفصل ${entry.chapter_label}${attrs.title ? ` — ${attrs.title}` : ""} [${languageName(language)}]`};
          try {await saveChapterIndex(env.DB,entry.manga_id,[updated]);} catch { /* current pages still work when ingestion is paused */ }
        } else {
          try {await upsertDoc(env, `sourceChapters/${chapterLocalId}`, {...mapping,remoteId:candidate,language,credits});} catch { /* legacy mapping remains readable */ }
        }
      }
      break;
    } catch (cause) {
      if (cause instanceof SourceHttpError && (cause.status === 404 || cause.status === 403)) continue;
      throw cause;
    }
  }
  if (!response) throw new Error("chapter_pages_empty");
  const chapter = response.chapter as Dict;
  const useSaver = Array.isArray(chapter.dataSaver) && chapter.dataSaver.length > 0;
  const files = (useSaver ? chapter.dataSaver : chapter.data) as string[];
  const base = String(response.baseUrl) + (useSaver ? "/data-saver/" : "/data/") + String(chapter.hash) + "/";
  if (!files?.length) throw new Error("chapter_pages_empty");
  const result: { index: number; url: string; filename: string }[] = [];
  for (const [index, file] of files.entries()) {
    const target = new URL(base + file);
    if (target.protocol !== "https:" || !SAFE_HOSTS.some((host) => target.hostname === host || target.hostname.endsWith(`.${host}`))) throw new Error("untrusted_image_host");
    result.push({ index, url: target.toString(), filename: `${String(index + 1).padStart(3, "0")}.${file.split(".").pop()?.replace(/[^a-z0-9]/gi, "") || "jpg"}` });
  }
  return result;
}

function u16(value: number): Uint8Array { return Uint8Array.of(value & 255, (value >>> 8) & 255); }
function u32(value: number): Uint8Array { return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255); }
function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const local: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const header = concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(file.data.length), u32(file.data.length), u16(name.length), u16(0), name]);
    local.push(header, file.data);
    directory.push(concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(file.data.length), u32(file.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += header.length + file.data.length;
  }
  const central = concat(directory);
  const end = concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(central.length), u32(offset), u16(0)]);
  return concat([...local, central, end]);
}

async function downloadChapterZip(env: Env, id: number): Promise<Response> {
  const assets = await chapterAssets(env, id);
  if (assets.length > 35) return error(413, "هذا الفصل طويل للتنزيل دفعة واحدة، يمكنك قراءته داخل التطبيق.");
  const files: { name: string; data: Uint8Array }[] = [];
  let size = 0;
  for (const asset of assets) {
    const response = await fetch(asset.url, { redirect: "manual", headers: { "user-agent": "YZ-Manga/1.0 (personal reader)" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return error(502, "تعذر تحميل صفحات الفصل من المصدر.");
    const remaining = 16 * 1024 * 1024 - size;
    if (Number(response.headers.get("content-length") ?? 0) > remaining || !response.body) return error(413, "حجم الفصل أكبر من الحد المسموح للتنزيل.");
    const chunks: Uint8Array[] = [];
    const stream = response.body.getReader();
    let received = 0;
    while (true) {
      const {value, done} = await stream.read();
      if (done) break;
      received += value.byteLength;
      if (received > remaining) { void stream.cancel(); return error(413, "حجم الفصل أكبر من الحد المسموح للتنزيل."); }
      chunks.push(value);
    }
    const data = concat(chunks);
    size += data.length;
    if (size > 16 * 1024 * 1024) return error(413, "حجم الفصل أكبر من الحد المسموح للتنزيل.");
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(type.split(";")[0])) return error(502, "تعذر قراءة صورة الفصل.");
    files.push({ name: asset.filename, data });
  }
  const zip = makeZip(files);
  return new Response(zip as unknown as BodyInit, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="chapter-${id}.zip"`, "cache-control": "no-store", "content-length": String(zip.length) } });
}

async function proxyImage(env: Env, id: number): Promise<Response> {
  const image = await getDoc(env, `sourceImages/${id}`);
  if (!image || typeof image.url !== "string") return error(404, "الصورة غير موجودة.");
  const parsed = new URL(image.url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port && parsed.port !== "443" || !SAFE_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) return error(404, "الصورة غير موجودة.");
  // Workers supports manual/follow only; manual + !ok rejects redirects without following them.
  const result = await fetch(parsed.toString(), { redirect: "manual", headers: { "user-agent": "YZ-Manga/1.0 (personal reader)" }, signal: AbortSignal.timeout(25_000) });
  if (!result.ok) return error(502, "تعذر تحميل الصورة من المصدر.");
  if (!["image/png", "image/jpeg", "image/webp"].includes((result.headers.get("content-type") ?? "").split(";")[0].toLowerCase())) return error(502, "تعذر قراءة الصورة.");
  const headers = new Headers({ "content-type": result.headers.get("content-type") ?? "image/jpeg", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" });
  return new Response(result.body, { status: 200, headers });
}

function unavailableReader(message = "صفحات هذا الفصل غير متاحة حاليًا", discussion=false): Response {
  return new Response(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#151515;color:#eee;font:18px sans-serif;padding:24px;line-height:1.8}</style><h2>${message}</h2><p>رقم الفصل محفوظ، ويمكنك استخدام زر التعليقات أعلاه.${discussion?'':' ستظهر الصفحات عند توفرها.'}</p></html>`, {headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"}});
}

export async function handleSourceRoutes(request: Request, env: Env, claims?: FirebaseClaims): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    const reader = /^\/reader\/(\d+)$/.exec(path);
    if (reader && request.method === "GET") {
      if(discussionsOnly(env))return unavailableReader('هذا الفصل مخصص للنقاش والتعليقات',true);
      const entry = await getDoc(env, `sourceChapters/${int(reader[1])}`);
      if (entry?.readable === false) return unavailableReader();
      const pages = await chapterPages(env, int(reader[1]), url.origin);
      if (!pages.length) return error(404, "لا توجد صفحات متاحة لهذا الفصل.");
      const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
      const mapping = await getDoc(env, `sourceChapters/${int(reader[1])}`);
      let credits = String(mapping?.credits ?? "");
      if (mapping && mapping.credits === undefined) {
        const metadata = await mangaDex(`/chapter/${encodeURIComponent(String(mapping.remoteId))}?includes[]=scanlation_group`);
        credits = (((metadata.data as Dict).relationships as Dict[]) ?? []).filter(item => item.type === "scanlation_group").map(item => String((item.attributes as Dict | undefined)?.name ?? "")).filter(Boolean).join(", ");
        await upsertDoc(env, `sourceChapters/${int(reader[1])}`, {...mapping, credits});
      }
      const creditPanel = `<details><summary>معلومات الفصل وحقوقه</summary><p>لغة الفصل: ${escape(languageName(String(mapping?.language ?? "ar")))}</p><p>إتاحة القراءة عبر MangaDex.</p><p>فريق الترجمة: ${escape(credits || "غير مسجل")}</p><p>حقوق العمل والترجمة لأصحابها.</p></details>`;
      const images = pages.map((page, index) => `<img src="${escape(String(page.page_image_url))}" alt="صفحة ${index + 1}" loading="${index === 0 ? "eager" : "lazy"}">`).join("");
      return new Response(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>قارئ MANGA SLAYER</title><style>body{margin:0;background:#151515;color:#eee;font-family:sans-serif}header{padding:16px;text-align:center}details{padding:10px 16px;color:#bbb;font-size:13px}summary{cursor:pointer}main{max-width:1200px;margin:auto}img{display:block;width:100%;height:auto;min-height:40px;margin:0 auto 8px}</style></head><body><header>${pages.length} صفحة</header>${creditPanel}<main>${images}</main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; img-src 'self' https://mangadex.org https://*.mangadex.org https://mangadex.network https://*.mangadex.network; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff" } });
    }
    if (path.startsWith("/source-image/") && request.method === "GET") {
      const id = int(path.slice("/source-image/".length));
      return id > 0 ? await proxyImage(env, id) : error(404, "الصورة غير موجودة.");
    }
    if (path === "/manga-app-api/download-chapter-as-zip" && request.method === "GET") {
      if(discussionsOnly(env))return error(403,'تحميل الصفحات متوقف؛ أرقام الفصول وتعليقاتها متاحة.');
      const id = int(url.searchParams.get("chapter_id"));
      return id > 0 ? await downloadChapterZip(env, id) : error(400, "اختر فصلاً.");
    }
    if (path === "/manga-app-api/get-all-published-manga" && request.method === "GET") return await listManga(env, url, url.origin, claims);
    if (path === "/manga-app-api/get-published-genres" && request.method === "GET") {
      const result = await mangaDex("/manga/tag");
      const values = ((result.data as Dict[]) ?? []).map((tag) => {
        const name = String(((tag.attributes as Dict).name as Dict).en ?? "");
        return { genre_id: tag.id, genre_name: TAG_NAMES[name] ?? name, genre_name_ar: TAG_NAMES[name] ?? name };
      });
      return collection(values, url.searchParams);
    }
    if (path === "/manga-app-api/get-published-manga-details-info" && request.method === "GET") {
      const localId = int(url.searchParams.get("manga_id"));
      const mapping = await getDoc(env, `sourceManga/${localId}`);
      if (!mapping) return error(404, "المانجا غير موجودة.");
      // Reading a saved list must remain read-only, even if the write quota is
      // unavailable. Synchronization owns its timestamps and background writes.
      if (["1", "true", "yes"].includes((url.searchParams.get("chapters") ?? "").toLowerCase())) {
        const values = await chapters(env, localId, String(mapping.remoteId), url.origin);
        return collection(values, url.searchParams);
      }
      const state=await syncState(env,localId);
      if(state?.manga_json) return response(JSON.parse(state.manga_json));
      const remote = await cachedMangaDex(env, `/manga/${encodeURIComponent(String(mapping.remoteId))}?includes[]=cover_art&includes[]=author`);
      const item = await convertManga(env, remote.data as Dict, url.origin);
      await rememberManga(env,item);
      return response(item);
    }
    if (path === "/manga-app-api/get-published-manga-chapter-pages" && request.method === "GET") {
      if(discussionsOnly(env))return collection([],url.searchParams);
      const id = int(url.searchParams.get("chapter_id"));
      const pages = await chapterPages(env, id, url.origin);
      return collection(pages, url.searchParams);
    }
  } catch (err) {
    console.error("source_route_failure", err instanceof Error ? err.message : "unknown_error");
    if (/^\/reader\/\d+$/.test(path) && !(err instanceof Error && err.message === "chapter_not_found")) return unavailableReader("تعذر تحميل صفحات الفصل حاليًا، حاول لاحقًا");
    if (err instanceof Error && err.message === "chapter_not_readable") return error(404, "صفحات هذا الفصل غير متاحة بعد؛ رقمه وتعليقاته محفوظة.");
    if (err instanceof Error && err.message === "chapter_not_found") return error(404, "الفصل غير موجود.");
    if (err instanceof Error && err.message.includes("mangadex")) return error(502, "تعذر تحميل المحتوى. جرّب لاحقاً.");
    return error(503, "تعذر تحميل المكتبة حالياً.");
  }
  return null;
}
