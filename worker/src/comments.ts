import {
  Env,
  FirebaseClaims,
  firestoreDocument,
  firestoreRequest,
  firestoreValue,
  jsonResponse,
  parseFirestoreDocument,
  readProfile,
} from "./index";

type MapValue = Record<string, unknown>;
type FirestoreDoc = MapValue & { name?: string; updateTime?: string };
const encoder = new TextEncoder();

const routes: Record<string, { kind: "chapter" | "manga"; action: "list" | "create" | "delete" | "update" | "react"; reply?: boolean; reaction?: "like" | "dislike" | "flag" }> = {
  "/manga-app-api/get-chapter-comments": { kind: "chapter", action: "list" },
  "/manga-app-api/get-chapter-comment-replies": { kind: "chapter", action: "list", reply: true },
  "/manga-app-api/add-chapter-comment": { kind: "chapter", action: "create" },
  "/manga-app-api/add-chapter-comment-reply": { kind: "chapter", action: "create", reply: true },
  "/manga-app-api/delete-chapter-comment": { kind: "chapter", action: "delete" },
  "/manga-app-api/delete-chapter-comment-reply": { kind: "chapter", action: "delete", reply: true },
  "/manga-app-api/update-chapter-comment": { kind: "chapter", action: "update" },
  "/manga-app-api/update-chapter-comment-reply": { kind: "chapter", action: "update", reply: true },
  "/manga-app-api/chapter-comment-like": { kind: "chapter", action: "react", reaction: "like" },
  "/manga-app-api/chapter-comment-reply-like": { kind: "chapter", action: "react", reply: true, reaction: "like" },
  "/manga-app-api/chapter-comment-dislike": { kind: "chapter", action: "react", reaction: "dislike" },
  "/manga-app-api/chapter-comment-reply-dislike": { kind: "chapter", action: "react", reply: true, reaction: "dislike" },
  "/manga-app-api/chapter-comment-flag": { kind: "chapter", action: "react", reaction: "flag" },
  "/manga-app-api/chapter-comment-reply-flag": { kind: "chapter", action: "react", reply: true, reaction: "flag" },
  "/manga-app-api/get-manga-comments": { kind: "manga", action: "list" },
  "/manga-app-api/get-manga-comment-replies": { kind: "manga", action: "list", reply: true },
  "/manga-app-api/add-manga-comment": { kind: "manga", action: "create" },
  "/manga-app-api/add-manga-comment-reply": { kind: "manga", action: "create", reply: true },
  "/manga-app-api/delete-manga-comment": { kind: "manga", action: "delete" },
  "/manga-app-api/delete-manga-comment-reply": { kind: "manga", action: "delete", reply: true },
  "/manga-app-api/update-manga-comment": { kind: "manga", action: "update" },
  "/manga-app-api/update-manga-comment-reply": { kind: "manga", action: "update", reply: true },
  "/manga-app-api/manga-comment-like": { kind: "manga", action: "react", reaction: "like" },
  "/manga-app-api/manga-comment-reply-like": { kind: "manga", action: "react", reply: true, reaction: "like" },
  "/manga-app-api/manga-comment-dislike": { kind: "manga", action: "react", reaction: "dislike" },
  "/manga-app-api/manga-comment-reply-dislike": { kind: "manga", action: "react", reply: true, reaction: "dislike" },
  "/manga-app-api/manga-comment-flag": { kind: "manga", action: "react", reaction: "flag" },
  "/manga-app-api/manga-comment-reply-flag": { kind: "manga", action: "react", reply: true, reaction: "flag" },
};

function fail(status: number, message: string): Response {
  return jsonResponse({ message, error: message, detail: message }, status);
}

function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : fallback;
}

function boolSpoiler(value: unknown): boolean {
  return ["1", "true", "yes"].includes(String(value ?? "0").toLowerCase());
}

function idName(value: unknown): string {
  const id = numberValue(value);
  return id > 0 ? `comments/${id}` : "";
}

function fields(doc: FirestoreDoc | null | undefined): MapValue | null {
  return doc ? parseFirestoreDocument(doc) : null;
}

function parseStream(text: string): FirestoreDoc[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((x) => x && typeof x === "object") as FirestoreDoc[];
  } catch {
    return trimmed.split(/\r?\n/).flatMap((line) => {
      try { return [JSON.parse(line) as FirestoreDoc]; } catch { return []; }
    });
  }
}

async function runQuery(env: Env, structuredQuery: MapValue, transaction?: string): Promise<FirestoreDoc[]> {
  const response = await firestoreRequest(env, ":runQuery", { method: "POST", body: JSON.stringify({ structuredQuery, ...(transaction ? { transaction } : {}) }) });
  if (!response.ok) throw new Error("firestore_query_failed");
  return parseStream(await response.text())
    .filter((entry) => entry.document)
    .map((entry) => entry.document as FirestoreDoc);
}

async function batchGet(env: Env, names: string[], transaction?: string): Promise<Map<string, FirestoreDoc | null>> {
  const response = await firestoreRequest(env, ":batchGet", {
    method: "POST",
    body: JSON.stringify({ documents: names.map((path) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`), ...(transaction ? { transaction } : {}) }),
  });
  if (!response.ok) throw new Error("firestore_read_failed");
  const result = new Map<string, FirestoreDoc | null>();
  for (const entry of parseStream(await response.text())) {
    const doc = (entry.found ?? null) as FirestoreDoc | null;
    const name = String(doc?.name ?? entry.missing ?? "");
    if (name) result.set(name.substring(name.indexOf("/documents/") + 11), doc);
  }
  for (const name of names) if (!result.has(name)) result.set(name, null);
  return result;
}

async function beginTransaction(env: Env): Promise<string> {
  const response = await firestoreRequest(env, ":beginTransaction", { method: "POST", body: JSON.stringify({ options: { readWrite: {} } }) });
  if (!response.ok) throw new Error("firestore_transaction_failed");
  return String(((await response.json()) as MapValue).transaction ?? "");
}

function updateWrite(env: Env, path: string, data: MapValue, previous: FirestoreDoc | null): MapValue {
  const documentName = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const write: MapValue = { update: firestoreDocument(documentName, data) };
  if (previous?.updateTime) write.currentDocument = { updateTime: previous.updateTime };
  else write.currentDocument = { exists: false };
  return write;
}

async function commit(env: Env, transaction: string, writes: MapValue[]): Promise<boolean> {
  const response = await firestoreRequest(env, ":commit", { method: "POST", body: JSON.stringify({ transaction, writes }) });
  if (response.ok) return true;
  if (response.status === 409 || response.status === 400) return false;
  throw new Error("firestore_commit_failed");
}

export async function consumeRateLimit(env: Env, scope: string, subject: string, maximum: number, periodSeconds: number): Promise<number> {
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${scope}:${subject}`)));
  const digest = Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const path = `rateLimits/${digest}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const tx = await beginTransaction(env);
    const docs = await batchGet(env, [path], tx);
    const doc = docs.get(path) ?? null;
    const current = fields(doc);
    const now = Math.floor(Date.now() / 1000);
    const start = numberValue(current?.windowStart);
    const active = start > 0 && now - start < periodSeconds;
    const used = active ? numberValue(current?.count) : 0;
    if (used >= maximum) return Math.max(1, periodSeconds - (now - start));
    const data = { windowStart: active ? start : now, count: used + 1, updatedAt: now };
    if (await commit(env, tx, [updateWrite(env, path, data, doc)])) return 0;
  }
  throw new Error("rate_limit_unavailable");
}

function randomLegacyId(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return Math.max(1, value);
}

export function legacyCommentDate(value: unknown): string {
  const text = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return text;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return "";
  // The installed legacy TimeUtil parses this format in Asia/Karachi (UTC+05:00).
  // Stored creation timestamps remain UTC; only the compatibility DTO is formatted.
  return new Date(timestamp + 5*60*60*1000).toISOString().slice(0,19).replace("T"," ");
}

function commentDto(data: MapValue, viewerUid: string): MapValue {
  const id = numberValue(data.id);
  const parent = numberValue(data.parentId);
  const chapter = data.kind === "chapter" ? numberValue(data.targetId) : 0;
  const manga = data.kind === "manga" ? numberValue(data.targetId) : 0;
  const isMine = data.uid === viewerUid;
  return {
    comment_id: parent || id,
    comment_reply_id: parent ? id : 0,
    manga_comment_id: parent || id,
    manga_comment_reply_id: parent ? id : 0,
    chapter_comment_id: parent || id,
    chapter_comment_reply_id: parent ? id : 0,
    manga_id: manga,
    chapter_id: chapter,
    comment_text: String(data.text ?? ""),
    reply_text: String(data.text ?? ""),
    spoiler: data.spoiler ? "Yes" : "No",
    user_id: numberValue(data.legacyUserId),
    user_full_name: String(data.displayName ?? "قارئ"),
    user_image_url: String(data.avatarUrl ?? ""),
    comment_at: legacyCommentDate(data.createdAt),
    comment_at_format: legacyCommentDate(data.createdAt),
    reply_at: legacyCommentDate(data.createdAt),
    created_at_iso: String(data.createdAt ?? ""),
    likes_count: numberValue(data.likes),
    dislikes_count: numberValue(data.dislikes),
    flaged_count: numberValue(data.flags),
    replies_count: numberValue(data.repliesCount),
    user_has_liked: data.viewerReaction === "like" ? "Yes" : "No",
    user_has_disliked: data.viewerReaction === "dislike" ? "Yes" : "No",
    user_has_flaged: data.viewerReaction === "flag" ? "Yes" : "No",
    is_mine: isMine,
  };
}

export function commentAvatarUrl(profile: MapValue | null, uid: string, origin: string): string {
  const revision = String(profile?.avatarRevision ?? "");
  return /^[A-Za-z0-9_-]{1,128}$/.test(uid) && /^[A-Za-z0-9_-]{8,80}$/.test(revision)
    ? `${origin}/avatars/${encodeURIComponent(uid)}/${encodeURIComponent(revision)}` : "";
}

async function hydrateComments(env: Env, values: MapValue[], viewerUid: string, origin: string): Promise<MapValue[]> {
  const paths = [...new Set(values.map(value => `profiles/${String(value.uid ?? "")}`))];
  const profiles = await batchGet(env, paths);
  return values.map(value => {
    const profile = fields(profiles.get(`profiles/${String(value.uid ?? "")}`));
    return commentDto({...value, avatarUrl: commentAvatarUrl(profile, String(value.uid ?? ""), origin),
      displayName: profile?.displayName ?? value.displayName}, viewerUid);
  });
}

async function getComment(env: Env, id: number): Promise<{ doc: FirestoreDoc; data: MapValue } | null> {
  if (!id) return null;
  const response = await firestoreRequest(env, `/${idName(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("firestore_read_failed");
  const doc = await response.json() as FirestoreDoc;
  return { doc, data: parseFirestoreDocument(doc) };
}

async function listComments(request: Request, env: Env, claims: FirebaseClaims, route: typeof routes[string]): Promise<Response> {
  const url = new URL(request.url);
  const params: Record<string, string> = Object.fromEntries(url.searchParams.entries());
  if (request.method !== "GET") {
    try { Object.assign(params, Object.fromEntries(new URLSearchParams(await request.text()).entries())); } catch { return fail(400, "بيانات الطلب غير صالحة."); }
  }
  const parentId = route.reply ? numberValue(params[`${route.kind}_comment_id`] ?? params.comment_id) : 0;
  const targetId = route.reply ? 0 : numberValue(params[`${route.kind}_id`]);
  if ((!route.reply && !targetId) || (route.reply && !parentId)) return fail(400, "اختر مانجا أو فصلاً.");
  if (route.reply && !await getComment(env, parentId).catch(() => null)) {
    return jsonResponse({ response: { data: [], total: 0, meta_data: { _limit: 30, _offset: 0, _order_by: "desc" } } });
  }
  const filters = [
    { fieldFilter: { field: { fieldPath: "kind" }, op: "EQUAL", value: firestoreValue(route.kind) } },
    { fieldFilter: { field: { fieldPath: "parentId" }, op: "EQUAL", value: firestoreValue(route.reply ? parentId : 0) } },
  ];
  if (!route.reply) filters.push({ fieldFilter: { field: { fieldPath: "targetId" }, op: "EQUAL", value: firestoreValue(targetId) } });
  const limit = Math.min(100, Math.max(1, numberValue(params._limit ?? params.limit, 30)));
  const offset = Math.max(0, numberValue(params._offset ?? params.offset));
  const order = String(params._order_by ?? "").toLowerCase().endsWith("asc") ? "ASCENDING" : "DESCENDING";
  try {
    const docs = await runQuery(env, {
      from: [{ collectionId: "comments" }],
      where: { compositeFilter: { op: "AND", filters } },
      orderBy: [{ field: { fieldPath: "id" }, direction: order }],
      offset,
      limit,
    });
    const reactionPaths = docs.map((doc) => {
      const id = numberValue(parseFirestoreDocument(doc).id);
      return `comments/${id}/reactions/${claims.sub}`;
    });
    const reactions = await batchGet(env, reactionPaths);
    const values = await hydrateComments(env, docs.map((doc, index) => {
      const data = parseFirestoreDocument(doc);
      const reaction = fields(reactions.get(reactionPaths[index]))?.kind;
      return { ...data, viewerReaction: reaction };
    }), claims.sub, url.origin);
    return jsonResponse({ response: { data: values, total: values.length + offset, meta_data: { _limit: limit, _offset: offset, _order_by: order.toLowerCase() } } });
  } catch {
    return fail(503, "تعذر تحميل التعليقات حالياً.");
  }
}

async function createComment(request: Request, env: Env, claims: FirebaseClaims, route: typeof routes[string]): Promise<Response> {
  let params: MapValue;
  try {
    const raw = await request.text();
    params = request.headers.get("content-type")?.includes("application/json") ? JSON.parse(raw) as MapValue : Object.fromEntries(new URLSearchParams(raw).entries());
  } catch { return fail(400, "بيانات التعليق غير صالحة."); }
  let targetId = numberValue(params[`${route.kind}_id`]);
  let parentId = 0;
  if (route.reply) {
    parentId = numberValue(params[`${route.kind}_comment_id`] ?? params.comment_id);
    const parent = await getComment(env, parentId).catch(() => null);
    if (!parent || parent.data.kind !== route.kind || numberValue(parent.data.parentId) !== 0) return fail(404, "التعليق غير موجود.");
    targetId = numberValue(parent.data.targetId);
  }
  if (!route.reply && targetId <= 0) return fail(400, "اختر مانجا أو فصلاً.");
  const text = String(params[route.reply ? "reply_text" : "comment_text"] ?? "").trim();
  if (!text || text.length > 5000) return fail(400, "التعليق من 1 إلى 5000 حرف.");
  const profile = await readProfile(env, claims.sub).catch(() => null);
  if (!profile) return fail(401, "الملف الشخصي غير جاهز.");

  const now = Math.floor(Date.now() / 1000);
  const normalized = text.normalize("NFKC").toLocaleLowerCase().replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${route.kind}|${targetId}|${parentId}|${normalized}`)));
  const digest = Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const id = randomLegacyId();
  const commentPath = `comments/${id}`;
  const gatePath = `profiles/${claims.sub}/postGate/shared`;
  const counterPath = `profiles/${claims.sub}/chapterCounters/${targetId}`;
  const duplicatePath = `profiles/${claims.sub}/duplicates/${digest}`;
  const counterIsUsed = route.kind === "chapter" && !route.reply;
  const commentData: MapValue = {
    id,
    kind: route.kind,
    targetId,
    parentId,
    uid: claims.sub,
    legacyUserId: profile.legacyId ?? 0,
    displayName: profile.displayName ?? claims.email?.split("@")[0] ?? "قارئ",
    avatarUrl: commentAvatarUrl(profile, claims.sub, new URL(request.url).origin),
    text,
    spoiler: boolSpoiler(params.spoiler),
    createdAt: new Date().toISOString(),
    likes: 0,
    dislikes: 0,
    flags: 0,
    repliesCount: 0,
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    let tx = "";
    try {
      tx = await beginTransaction(env);
      const names = [gatePath, duplicatePath, ...(counterIsUsed ? [counterPath] : [])];
      const docs = await batchGet(env, names, tx);
      const gate = docs.get(gatePath) ?? null;
      const duplicate = docs.get(duplicatePath) ?? null;
      const counter = counterIsUsed ? docs.get(counterPath) ?? null : null;
      const gateData = fields(gate);
      const duplicateData = fields(duplicate);
      const counterData = fields(counter);
      if (counterIsUsed && numberValue(counterData?.count) >= 2) {
        return fail(409, "لديك تعليقان في هذا الفصل. احذف أحد تعليقاتك القديمة قبل إضافة تعليق جديد.");
      }
      if (duplicateData && now - numberValue(duplicateData.postedAt) < 300) return fail(429, "نشرت هذا التعليق بالفعل. لا تكرر النص نفسه.");
      const lastAt = numberValue(gateData?.lastAt);
      if (lastAt && now - lastAt < 60) {
        return jsonResponse({ message: "انتظر دقيقة كاملة بين التعليقات والردود.", error: "انتظر دقيقة كاملة بين التعليقات والردود.", detail: "CommentCooldown", retry_after: 60 - (now - lastAt) }, 429, { "retry-after": String(60 - (now - lastAt)) });
      }
      const writes: MapValue[] = [
        updateWrite(env, gatePath, { lastAt: now, requestId: crypto.randomUUID() }, gate),
        updateWrite(env, duplicatePath, { postedAt: now }, duplicate),
        updateWrite(env, commentPath, commentData, null),
      ];
      if (counterIsUsed) writes.push(updateWrite(env, counterPath, { count: numberValue(counterData?.count) + 1 }, counter));
      if (parentId) {
        const parentName = `comments/${parentId}`;
        const parentDoc = await batchGet(env, [parentName], tx);
        const parentRaw = parentDoc.get(parentName);
        if (!parentRaw) return fail(404, "التعليق لم يعد موجوداً.");
        if (parentRaw) {
          const parentData = parseFirestoreDocument(parentRaw);
          writes.push(updateWrite(env, parentName, { ...parentData, repliesCount: numberValue(parentData.repliesCount) + 1 }, parentRaw));
        }
      }
      if (await commit(env, tx, writes)) return jsonResponse({ response: { data: (await hydrateComments(env, [commentData], claims.sub, new URL(request.url).origin))[0] } });
    } catch {
      return fail(503, "تعذر نشر التعليق حالياً.");
    }
  }
  return fail(503, "الخادم مشغول، حاول مجدداً.");
}

async function mutateComment(request: Request, env: Env, claims: FirebaseClaims, route: typeof routes[string]): Promise<Response> {
  const params: MapValue = Object.fromEntries(new URL(request.url).searchParams.entries());
  try {
    const raw = await request.text();
    if (raw.trim()) {
      const body = request.headers.get("content-type")?.includes("application/json") ? JSON.parse(raw) as MapValue : Object.fromEntries(new URLSearchParams(raw).entries());
      if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "بيانات الطلب غير صالحة.");
      for (const [key,value] of Object.entries(body)) {
        if (key in params && String(params[key]) !== String(value)) return fail(400, "بيانات الطلب متعارضة.");
        params[key] = value;
      }
    }
  } catch { return fail(400, "بيانات الطلب غير صالحة."); }
  const id = numberValue(route.reply ? params[`${route.kind}_comment_reply_id`] : params[`${route.kind}_comment_id`]);
  const found = await getComment(env, id).catch(() => null);
  if (!found || found.data.kind !== route.kind || Boolean(numberValue(found.data.parentId)) !== Boolean(route.reply)) return fail(404, "التعليق غير موجود.");
  if (route.action === "delete" || route.action === "update") {
    if (found.data.uid !== claims.sub) return fail(403, "يمكنك تعديل أو حذف تعليقاتك فقط.");
    if (route.action === "delete") {
      try {
        const tx = await beginTransaction(env);
        const counterPath = `profiles/${claims.sub}/chapterCounters/${numberValue(found.data.targetId)}`;
        const names = [idName(id), ...(route.kind === "chapter" && !route.reply ? [counterPath] : [])];
        const docs = await batchGet(env, names, tx);
        const latest = docs.get(idName(id));
        if (!latest) return fail(404, "التعليق غير موجود.");
        const latestData = parseFirestoreDocument(latest);
        if (latestData.uid !== claims.sub) return fail(403, "يمكنك تعديل أو حذف تعليقاتك فقط.");
        const writes: MapValue[] = [{ delete: latest.name, currentDocument: {updateTime: latest.updateTime} }];
        if (!route.reply) {
          const children = await runQuery(env, {
            from: [{ collectionId: "comments" }],
            where: { fieldFilter: { field: { fieldPath: "parentId" }, op: "EQUAL", value: firestoreValue(id) } },
            limit: 401,
          }, tx);
          if (children.length > 400) return fail(409, "لا يمكن حذف هذا التعليق الآن بسبب عدد الردود الكبير.");
          for (const child of children) if (child.name) writes.push({ delete: child.name });
        }
        if (route.kind === "chapter" && !route.reply) {
          const counterDoc = docs.get(counterPath) ?? null;
          const counterData = fields(counterDoc);
          writes.push(updateWrite(env, counterPath, { count: Math.max(0, numberValue(counterData?.count) - 1) }, counterDoc));
        }
        if (route.reply) {
          const parentId = numberValue(latestData.parentId);
          const parentPath = idName(parentId);
          const parentMap = await batchGet(env, [parentPath], tx);
          const parentDoc = parentMap.get(parentPath);
          if (parentDoc) {
            const parentData = parseFirestoreDocument(parentDoc);
            writes.push(updateWrite(env, parentPath, { ...parentData, repliesCount: Math.max(0, numberValue(parentData.repliesCount) - 1) }, parentDoc));
          }
        }
        if (!await commit(env, tx, writes)) return fail(409, "تغير التعليق، أعد المحاولة.");
        return jsonResponse({ response: { success: true } });
      } catch { return fail(503, "تعذر حذف التعليق حالياً."); }
    }
    const text = String(params[route.reply ? "reply_text" : "comment_text"] ?? "").trim();
    if (!text || text.length > 5000) return fail(400, "التعليق من 1 إلى 5000 حرف.");
    const retry = await consumeRateLimit(env, "comment_edits_user", claims.sub, 1, 60);
    if (retry) return jsonResponse({message: "انتظر دقيقة بين تعديلات التعليقات.", error: "RequestLimited"}, 429, {"retry-after": String(retry)});
    const data = { ...found.data, text, spoiler: boolSpoiler(params.spoiler), editedAt: new Date().toISOString() };
    const response = await firestoreRequest(env, `/${idName(id)}?currentDocument.updateTime=${encodeURIComponent(String(found.doc.updateTime))}&updateMask.fieldPaths=text&updateMask.fieldPaths=spoiler&updateMask.fieldPaths=editedAt`, { method: "PATCH", body: JSON.stringify(firestoreDocument(found.doc.name ?? `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${idName(id)}`, data)) });
    if (response.status === 409) return fail(409, "تغير التعليق، أعد المحاولة.");
    if (!response.ok) return fail(503, "تعذر تعديل التعليق حالياً.");
    return jsonResponse({ response: { data: (await hydrateComments(env, [data], claims.sub, new URL(request.url).origin))[0] } });
  }

  const reaction = route.reaction ?? "like";
  const reactionRetry = await consumeRateLimit(env, "reactions_user", claims.sub, 1, 5);
  if (reactionRetry) return jsonResponse({message: "انتظر خمس ثوانٍ بين التفاعلات.", error: "RequestLimited"}, 429, {"retry-after": String(reactionRetry)});
  const reactionPath = `comments/${id}/reactions/${claims.sub}`;
  try {
    const tx = await beginTransaction(env);
    const latest = await batchGet(env, [idName(id), reactionPath], tx);
    const latestComment = latest.get(idName(id));
    const latestReaction = latest.get(reactionPath);
    if (!latestComment) return fail(404, "التعليق غير موجود.");
    const latestData = parseFirestoreDocument(latestComment);
    const latestOld = latestReaction ? String(parseFirestoreDocument(latestReaction).kind ?? "") : "";
    let latestNext: string = reaction;
    if (reaction !== "flag" && latestOld === reaction) latestNext = "";
    const updated = { ...latestData };
    for (const [key, kind] of [["likes", "like"], ["dislikes", "dislike"], ["flags", "flag"]]) {
      updated[key] = Math.max(0, numberValue(latestData[key]) + (latestNext === kind ? 1 : 0) - (latestOld === kind ? 1 : 0));
    }
    const transactionWrites = [updateWrite(env, idName(id), updated, latestComment)];
    if (latestNext) transactionWrites.push(updateWrite(env, reactionPath, { kind: latestNext, uid: claims.sub, updatedAt: new Date().toISOString() }, latestReaction ?? null));
    else if (latestReaction?.name) transactionWrites.push({ delete: latestReaction.name });
    if (!await commit(env, tx, transactionWrites)) return fail(409, "تغير التعليق، أعد المحاولة.");
    return jsonResponse({ response: { data: (await hydrateComments(env, [{ ...updated, viewerReaction: latestNext }], claims.sub, new URL(request.url).origin))[0] } });
  } catch { return fail(503, "تعذر تحديث التفاعل حالياً."); }
}

export async function handleCommentRoutes(request: Request, env: Env, claims: FirebaseClaims): Promise<Response | null> {
  const route = routes[new URL(request.url).pathname];
  if (!route) return null;
  if (route.action === "delete" && request.method !== "DELETE") return fail(405, "طريقة الطلب غير مدعومة.");
  if (route.action !== "list") {
    try {
      if (route.action === "react" && route.reaction === "flag") {
        const reportRetry = await consumeRateLimit(env, "reports_user", claims.sub, 15, 3600);
        if (reportRetry) return jsonResponse({ message: "وصلت إلى حد البلاغات المؤقت.", error: "RequestLimited", retry_after: reportRetry }, 429, { "retry-after": String(reportRetry) });
      }
    } catch { return fail(503, "الحماية مشغولة مؤقتاً. حاول لاحقاً."); }
  }
  if (route.action === "list") return listComments(request, env, claims, route);
  if (route.action === "create") return createComment(request, env, claims, route);
  return mutateComment(request, env, claims, route);
}
