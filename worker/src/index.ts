import { protectRequest, SecurityBindings } from "./security";
import { sanitizeAvatar } from "./avatar";
import { lookupCompactChapter, chapterMapping } from "./chapter-index";
export interface Env extends SecurityBindings {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_WEB_API_KEY: string;
  DB: D1Database;
  ALLOWED_ORIGINS?: string;
  DISCUSSIONS_ONLY?: string;
}

export interface FirebaseClaims {
  sub: string;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
  auth_time: number;
  email?: string;
  email_verified?: boolean;
}

type JsonMap = Record<string, unknown>;
import { consumeRateLimit, handleCommentRoutes } from "./comments";
import { handleSourceRoutes, refreshSourceIndexes } from "./source";
import { handleLibraryRoutes } from "./library";

const GOOGLE_KEYS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const MAX_BODY_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let jwksCache: { expires: number; keys: JsonWebKey[] } | undefined;
const activeSessions = new Map<string, number>();

async function sessionIsActive(env: Env, token: string, claims: FirebaseClaims): Promise<boolean> {
  const key = token.slice(-48);
  if ((activeSessions.get(key) ?? 0) > Date.now()) return true;
  const {response, data} = await firebaseAuth(env, "accounts:lookup", {idToken: token});
  if (response.status >= 500 || response.status === 429) throw new Error("auth_service_unavailable");
  const user = ((data.users ?? []) as JsonMap[])[0];
  if (!response.ok || !user || user.localId !== claims.sub || user.disabled === true || Number(user.validSince ?? 0) > claims.auth_time) return false;
  if (activeSessions.size >= 256) activeSessions.clear();
  activeSessions.set(key, Date.now() + 30_000);
  return true;
}

function b64urlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function b64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function error(status: number, message: string): Response {
  return jsonResponse({ message, error: message }, status);
}

async function authLimits(request: Request, env: Env, entries: Array<[string, string, number, number]>): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const all = [["auth_ip", ip, 60, 300] as [string, string, number, number], ...entries];
  try {
    for (const [scope, subject, maximum, period] of all) {
      const retry = await consumeRateLimit(env, scope, subject, maximum, period);
      if (retry) return jsonResponse({ message: "محاولات كثيرة، حاول بعد قليل.", error: "RequestLimited", retry_after: retry }, 429, { "retry-after": String(retry) });
    }
    return null;
  } catch { return error(503, "الحماية مشغولة مؤقتاً. حاول لاحقاً."); }
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "*").split(",").map((v) => v.trim());
  const allowOrigin = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : "null";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type, X-Device-Id",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

async function verifyFirebaseIdToken(token: string, projectId: string): Promise<FirebaseClaims> {
  if (token.length > 16_384) throw new Error("invalid_token");
  const pieces = token.split(".");
  if (pieces.length !== 3) throw new Error("invalid_token");
  const header = JSON.parse(decoder.decode(b64urlBytes(pieces[0]))) as { alg?: string; kid?: string };
  const claims = JSON.parse(decoder.decode(b64urlBytes(pieces[1]))) as FirebaseClaims;
  if (header.alg !== "RS256" || !header.kid) throw new Error("invalid_token");

  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}` ||
      !claims.sub || !/^[A-Za-z0-9_-]{1,128}$/.test(claims.sub) ||
      !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || !Number.isFinite(claims.auth_time) ||
      claims.exp <= now || claims.iat > now + 60 || claims.auth_time > now + 60) throw new Error("invalid_token");

  if (!jwksCache || jwksCache.expires < Date.now()) {
    const response = await fetch(GOOGLE_KEYS_URL);
    if (!response.ok) throw new Error("key_service_unavailable");
    const body = await response.json() as { keys?: JsonWebKey[] };
    jwksCache = { keys: body.keys ?? [], expires: Date.now() + 50 * 60 * 1000 };
  }
  const jwk = jwksCache.keys.find((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid);
  if (!jwk) {
    jwksCache = undefined;
    throw new Error("unknown_signing_key");
  }
  const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, b64urlBytes(pieces[2]), encoder.encode(`${pieces[0]}.${pieces[1]}`));
  if (!valid) throw new Error("invalid_token");
  return claims;
}

export function firestoreValue(value: unknown): JsonMap {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (typeof value === "object") {
    const fields: Record<string, JsonMap> = {};
    for (const [key, item] of Object.entries(value as JsonMap)) fields[key] = firestoreValue(item);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

function plainValue(value: JsonMap): unknown {
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return ((value.arrayValue as { values?: JsonMap[] }).values ?? []).map(plainValue);
  if ("mapValue" in value) return Object.fromEntries(Object.entries((value.mapValue as { fields?: Record<string, JsonMap> }).fields ?? {}).map(([k, v]) => [k, plainValue(v)]));
  return undefined;
}

export function firestoreDocument(name: string, data: JsonMap): JsonMap {
  return { name, fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, firestoreValue(value)])) };
}

export function parseFirestoreDocument(doc: JsonMap): JsonMap {
  const fields = (doc.fields ?? {}) as Record<string, JsonMap>;
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, plainValue(value)]));
}

type StoredDocument = { path: string; fields: string; updated_at: number };
type FirestoreWrite = { update?: JsonMap; delete?: string; currentDocument?: { exists?: boolean; updateTime?: string } };

function fullDocumentName(env: Env, path: string): string {
  return `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
}

function storedDocument(env: Env, row: StoredDocument): JsonMap {
  return { name: fullDocumentName(env, row.path), fields: JSON.parse(row.fields), updateTime: String(row.updated_at) };
}

function fromDocumentName(name: string): string {
  const marker = "/documents/";
  const index = name.indexOf(marker);
  return index < 0 ? name.replace(/^\/+/, "") : name.slice(index + marker.length);
}

function firestoreResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function fieldsObject(document: JsonMap): Record<string, JsonMap> {
  return (document.fields ?? {}) as Record<string, JsonMap>;
}

async function readStoredDocument(env: Env, path: string): Promise<StoredDocument | null> {
  return await env.DB.prepare("SELECT path, fields, updated_at FROM documents WHERE path = ?1")
    .bind(path).first<StoredDocument>();
}

function writePrecondition(write: FirestoreWrite, path: string, parameterStart: number): { sql: string; values: unknown[] } | null {
  const condition = write.currentDocument;
  if (!condition) return null;
  if (condition.exists === false) return { sql: `NOT EXISTS (SELECT 1 FROM documents WHERE path = ?${parameterStart})`, values: [path] };
  if (condition.updateTime !== undefined) return { sql: `EXISTS (SELECT 1 FROM documents WHERE path = ?${parameterStart} AND updated_at = ?${parameterStart + 1})`, values: [path, Number(condition.updateTime)] };
  if (condition.exists === true) return { sql: `EXISTS (SELECT 1 FROM documents WHERE path = ?${parameterStart})`, values: [path] };
  return null;
}

async function commitFirestoreWrites(env: Env, writes: FirestoreWrite[]): Promise<boolean> {
  const statements: D1PreparedStatement[] = [];
  const checks: string[] = [];
  const checkValues: unknown[] = [];
  for (const write of writes) {
    const path = write.delete ? fromDocumentName(write.delete) : fromDocumentName(String(write.update?.name ?? ""));
    const precondition = writePrecondition(write, path, checkValues.length + 1);
    if (precondition) { checks.push(`(${precondition.sql})`); checkValues.push(...precondition.values); }
  }
  if (checks.length) {
    statements.push(env.DB.prepare(`INSERT INTO write_guard(ok) SELECT CASE WHEN ${checks.join(" AND ")} THEN 1 ELSE 0 END`).bind(...checkValues));
  }
  for (const write of writes) {
    if (write.delete) {
      statements.push(env.DB.prepare("DELETE FROM documents WHERE path = ?1").bind(fromDocumentName(write.delete)));
      continue;
    }
    if (!write.update) continue;
    const path = fromDocumentName(String(write.update.name ?? ""));
    const fields = JSON.stringify(fieldsObject(write.update));
    statements.push(env.DB.prepare("INSERT INTO documents(path, fields, updated_at) VALUES(?1, ?2, 1) ON CONFLICT(path) DO UPDATE SET fields = excluded.fields, updated_at = documents.updated_at + 1")
      .bind(path, fields));
  }
  if (checks.length) statements.push(env.DB.prepare("DELETE FROM write_guard"));
  try { await env.DB.batch(statements); return true; }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("write_guard") || message.includes("CHECK constraint failed")) return false;
    throw cause;
  }
}

function queryMatches(document: JsonMap, filter: JsonMap): boolean {
  if (filter.compositeFilter) {
    const composite = filter.compositeFilter as JsonMap;
    const filters = (composite.filters ?? []) as JsonMap[];
    return composite.op === "OR" ? filters.some((item) => queryMatches(document, item)) : filters.every((item) => queryMatches(document, item));
  }
  const fieldFilter = filter.fieldFilter as JsonMap | undefined;
  if (!fieldFilter) return true;
  const field = String((fieldFilter.field as JsonMap | undefined)?.fieldPath ?? "");
  const op = String(fieldFilter.op ?? "EQUAL");
  const expected = plainValue((fieldFilter.value ?? {}) as JsonMap);
  const actual = parseFirestoreDocument(document)[field];
  if (op === "EQUAL") return actual === expected;
  if (op === "NOT_EQUAL") return actual !== expected;
  if (op === "LESS_THAN") return (actual as never) < (expected as never);
  if (op === "LESS_THAN_OR_EQUAL") return (actual as never) <= (expected as never);
  if (op === "GREATER_THAN") return (actual as never) > (expected as never);
  if (op === "GREATER_THAN_OR_EQUAL") return (actual as never) >= (expected as never);
  return false;
}

function queryFilterSql(filter: JsonMap, values: unknown[]): string | null {
  const composite = filter.compositeFilter as JsonMap | undefined;
  if (composite) {
    const children = ((composite.filters ?? []) as JsonMap[]).map((child) => queryFilterSql(child, values));
    if (children.some((child) => child === null)) return null;
    const joiner = composite.op === "OR" ? " OR " : " AND ";
    return `(${(children as string[]).join(joiner)})`;
  }
  const fieldFilter = filter.fieldFilter as JsonMap | undefined;
  if (!fieldFilter) return null;
  const field = String((fieldFilter.field as JsonMap | undefined)?.fieldPath ?? "");
  const sqlField = ({
    id: "CAST(json_extract(fields, '$.id.integerValue') AS INTEGER)",
    kind: "json_extract(fields, '$.kind.stringValue')",
    targetId: "CAST(json_extract(fields, '$.targetId.integerValue') AS INTEGER)",
    parentId: "CAST(json_extract(fields, '$.parentId.integerValue') AS INTEGER)",
  } as Record<string, string>)[field];
  const operator = ({ EQUAL: "=", NOT_EQUAL: "!=", LESS_THAN: "<", LESS_THAN_OR_EQUAL: "<=", GREATER_THAN: ">", GREATER_THAN_OR_EQUAL: ">=" } as Record<string, string>)[String(fieldFilter.op ?? "EQUAL")];
  if (!sqlField || !operator) return null;
  values.push(plainValue((fieldFilter.value ?? {}) as JsonMap));
  return `${sqlField} ${operator} ?${values.length}`;
}

async function runFirestoreQuery(env: Env, body: JsonMap): Promise<Response> {
  const query = (body.structuredQuery ?? {}) as JsonMap;
  const from = ((query.from ?? []) as JsonMap[])[0] ?? {};
  const collection = String(from.collectionId ?? "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(collection)) return firestoreResponse({ error: "invalid_query" }, 400);
  const prefix = `${collection}/`;
  const orderBy = ((query.orderBy ?? []) as JsonMap[])[0];
  const offset = Math.max(0, Number(query.offset ?? 0));
  const limit = Math.min(1000, Math.max(0, Number(query.limit ?? 1000)));
  const values: unknown[] = [`${prefix}%`, collection.length + 2];
  const collectionScope = collection === "comments" ? "path GLOB 'comments/[0-9]*' AND " : "";
  const where = query.where ? queryFilterSql(query.where as JsonMap, values) : "1";
  if (where !== null) {
    const orderField = orderBy ? String(((orderBy.field ?? {}) as JsonMap).fieldPath ?? "") : "";
    const orderColumn = orderField === "id" ? "CAST(json_extract(fields, '$.id.integerValue') AS INTEGER)" : "path";
    const direction = orderBy?.direction === "ASCENDING" ? "ASC" : "DESC";
    values.push(limit, offset);
    const rows = await env.DB.prepare(`SELECT path, fields, updated_at FROM documents WHERE ${collectionScope}path LIKE ?1 AND instr(substr(path, ?2), '/') = 0 AND (${where}) ORDER BY ${orderColumn} ${direction} LIMIT ?${values.length - 1} OFFSET ?${values.length}`)
      .bind(...values).all<StoredDocument>();
    return firestoreResponse((rows.results ?? []).map((row) => ({ document: storedDocument(env, row) })));
  }
  // Unknown query shapes remain correct, but use the optimized SQL path for every route in this API.
  const rows = await env.DB.prepare("SELECT path, fields, updated_at FROM documents WHERE path LIKE ?1")
    .bind(`${prefix}%`).all<StoredDocument>();
  let docs = (rows.results ?? []).filter((row) => !row.path.slice(prefix.length).includes("/"))
    .map((row) => storedDocument(env, row)).filter((doc) => !query.where || queryMatches(doc, query.where as JsonMap));
  if (orderBy) {
    const field = String(((orderBy.field ?? {}) as JsonMap).fieldPath ?? "");
    const direction = orderBy.direction === "ASCENDING" ? 1 : -1;
    docs.sort((a, b) => {
      const left = parseFirestoreDocument(a)[field] as string | number;
      const right = parseFirestoreDocument(b)[field] as string | number;
      return left < right ? -direction : left > right ? direction : 0;
    });
  }
  return firestoreResponse(docs.slice(offset, offset + limit).map((document) => ({ document })));
}

export async function firestoreRequest(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, "https://d1.local");
  const endpoint = url.pathname.replace(/^\/+/, "");
  const method = String(init.method ?? "GET").toUpperCase();
  let body: JsonMap = {};
  if (typeof init.body === "string" && init.body) {
    try { body = JSON.parse(init.body) as JsonMap; } catch { return firestoreResponse({ error: "invalid_json" }, 400); }
  }
  try {
    if (endpoint === ":beginTransaction" && method === "POST") return firestoreResponse({ transaction: crypto.randomUUID() });
    if (endpoint === ":batchGet" && method === "POST") {
      const names = [...new Set(((body.documents ?? []) as string[]).map((name) => fromDocumentName(String(name))))];
      if (names.length > 100) return firestoreResponse({ error: "too_many_documents" }, 400);
      const found = names.length ? await env.DB.prepare(`SELECT path, fields, updated_at FROM documents WHERE path IN (${names.map((_, index) => `?${index + 1}`).join(",")})`).bind(...names).all<StoredDocument>() : { results: [] as StoredDocument[] };
      const byPath = new Map((found.results ?? []).map((row) => [row.path, row]));
      const results = names.map((docPath) => {
        const row = byPath.get(docPath);
        return row ? { found: storedDocument(env, row) } : { missing: fullDocumentName(env, docPath) };
      });
      return firestoreResponse(results);
    }
    if (endpoint === ":runQuery" && method === "POST") return await runFirestoreQuery(env, body);
    if (endpoint === ":commit" && method === "POST") {
      const committed = await commitFirestoreWrites(env, (body.writes ?? []) as FirestoreWrite[]);
      return committed ? firestoreResponse({ writeResults: [] }) : firestoreResponse({ error: "failed_precondition" }, 409);
    }
    const docPath = decodeURIComponent(endpoint);
    if (!docPath || docPath.startsWith(":")) return firestoreResponse({ error: "not_found" }, 404);
    if (method === "GET") {
      const chapter=/^sourceChapters\/(\d+)$/.exec(docPath);
      if(chapter) {
        const entry=await lookupCompactChapter(env.DB,Number(chapter[1]));
        if(entry) return firestoreResponse({...firestoreDocument(fullDocumentName(env,docPath),chapterMapping(entry)),updateTime:'1'});
      }
      const row = await readStoredDocument(env, docPath);
      return row ? firestoreResponse(storedDocument(env, row)) : firestoreResponse({ error: "not_found" }, 404);
    }
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM documents WHERE path = ?1").bind(docPath).run();
      return firestoreResponse({});
    }
    if (method === "PATCH") {
      const incoming = fieldsObject(body);
      const mask = url.searchParams.getAll("updateMask.fieldPaths");
      let documentFields = incoming;
      let currentDocument: FirestoreWrite["currentDocument"];
      if (url.searchParams.has("currentDocument.exists")) currentDocument = {exists: url.searchParams.get("currentDocument.exists") === "true"};
      if (url.searchParams.has("currentDocument.updateTime")) currentDocument = {...currentDocument, updateTime: url.searchParams.get("currentDocument.updateTime")!};
      if (mask.length) {
        const row = await readStoredDocument(env, docPath);
        const currentFields = row ? JSON.parse(row.fields) as Record<string, JsonMap> : {};
        documentFields = { ...currentFields };
        for (const field of mask) {
          if (incoming[field] !== undefined) documentFields[field] = incoming[field];
          else delete documentFields[field];
        }
        currentDocument ??= row ? { exists: true, updateTime: String(row.updated_at) } : { exists: false };
      }
      const write: FirestoreWrite = {
        update: { name: fullDocumentName(env, docPath), fields: documentFields },
        ...(currentDocument ? { currentDocument } : {}),
      };
      const committed = await commitFirestoreWrites(env, [write]);
      if (!committed) return firestoreResponse({ error: "failed_precondition" }, 409);
      const updated = await readStoredDocument(env, docPath);
      return updated ? firestoreResponse(storedDocument(env, updated)) : firestoreResponse({ error: "not_found" }, 404);
    }
    return firestoreResponse({ error: "unsupported_method" }, 405);
  } catch {
    return firestoreResponse({ error: "d1_store_failed" }, 503);
  }
}

export async function readProfile(env: Env, uid: string): Promise<JsonMap | null> {
  const result = await firestoreRequest(env, `/profiles/${encodeURIComponent(uid)}`);
  if (result.status === 404) return null;
  if (!result.ok) throw new Error("firestore_read_failed");
  return parseFirestoreDocument(await result.json() as JsonMap);
}

export async function ensureProfile(env: Env, uid: string, email: string, preferredName?: string): Promise<JsonMap> {
  const current = await readProfile(env, uid);
  if (current) {
    if (typeof current.legacyId === "number") await ensureLegacyIndex(env, current.legacyId, uid);
    return current;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(uid)));
  // The legacy Android model requires a signed 64-bit numeric user_id.
  // A 48-bit deterministic value avoids unsafe JSON integer precision.
  let legacyId = 0;
  for (let i = 0; i < 6; i++) legacyId = legacyId * 256 + digest[i];
  const profile: JsonMap = {
    legacyId,
    email,
    displayName: preferredName?.trim() || email.split("@")[0] || "قارئ",
    avatarRevision: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    await writeProfile(env, uid, profile, true);
    await ensureLegacyIndex(env, legacyId, uid);
    return profile;
  } catch (err) {
    if (err instanceof Error && err.message === "profile_exists") {
      const raced = await readProfile(env, uid);
      if (raced) return raced;
    }
    throw err;
  }
}

async function ensureLegacyIndex(env: Env, legacyId: number, uid: string): Promise<void> {
  const path = `legacyUsers/${legacyId}`;
  const existing = await firestoreRequest(env, `/${path}`);
  if (existing.ok) return;
  if (existing.status !== 404) throw new Error("legacy_index_unavailable");
  const name = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const created = await firestoreRequest(env, `/${path}?currentDocument.exists=false`, { method: "PATCH", body: JSON.stringify(firestoreDocument(name, { uid })) });
  if (!created.ok && created.status !== 409 && created.status !== 400) throw new Error("legacy_index_unavailable");
}

async function bindDevice(env: Env, uid: string, deviceId: string, newAccount = false): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(deviceId)) throw new Error("device_required");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(deviceId)));
  const deviceHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const path = `device_accounts/${deviceHash}`;
  const response = await firestoreRequest(env, `/${path}`);
  if (response.ok) {
    const doc = await response.json() as JsonMap;
    const record = parseFirestoreDocument(doc);
    if (newAccount || record.uid !== uid) throw new Error("device_already_bound");
    return;
  }
  if (response.status !== 404) throw new Error("device_store_unavailable");
  const fullName = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const created = await firestoreRequest(env, `/${path}?currentDocument.exists=false`, {
    method: "PATCH",
    body: JSON.stringify(firestoreDocument(fullName, { uid, createdAt: new Date().toISOString() })),
  });
  if (!created.ok) {
    if (created.status === 409 || created.status === 400) throw new Error("device_already_bound");
    throw new Error("device_store_unavailable");
  }
}

function legacyUser(profile: JsonMap, uid: string, email: string, origin = ""): JsonMap {
  const legacyId = typeof profile.legacyId === "number" ? profile.legacyId : 0;
  const displayName = typeof profile.displayName === "string" ? profile.displayName : email.split("@")[0] || "قارئ";
  return {
    user_id: legacyId,
    username: email,
    user_status: "1",
    scope: "user",
    user_full_name: displayName,
    user_image: "",
    user_image_url: typeof profile.avatarRevision === "string" && profile.avatarRevision && origin ? `${origin}/avatars/${encodeURIComponent(uid)}/${encodeURIComponent(profile.avatarRevision)}` : "",
    chapters_limit: 100,
    last_chapter_download_at: "",
    total_manga_user_favorites: 0,
    total_manga_user_watching: 0,
    total_manga_user_plan_to_watch: 0,
    total_manga_user_watched: 0,
    total_manga_user_dropped: 0,
    total_manga_user_chapters_watched: 0,
  };
}

async function firebaseAuth(env: Env, endpoint: string, body: JsonMap): Promise<{ response: Response; data: JsonMap }> {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as JsonMap;
  return { response, data };
}

function authError(data: JsonMap): Response {
  const code = (data.error as JsonMap | undefined)?.message;
  if (code === "EMAIL_EXISTS") return error(409, "هذا البريد مسجل مسبقاً.");
  if (code === "EMAIL_NOT_FOUND" || code === "INVALID_PASSWORD" || code === "INVALID_LOGIN_CREDENTIALS") return error(401, "البريد أو كلمة المرور غير صحيحة.");
  if (code === "WEAK_PASSWORD") return error(400, "كلمة المرور يجب أن تكون 8 أحرف على الأقل.");
  if (code === "INVALID_EMAIL") return error(400, "أدخل بريداً صالحاً.");
  if (code === "TOO_MANY_ATTEMPTS_TRY_LATER") return error(429, "محاولات كثيرة، حاول لاحقاً.");
  return error(400, "تعذر إتمام طلب الحساب.");
}

async function legacyAuthResponse(env: Env, data: JsonMap, preferredName?: string, deviceId = "", newAccount = false, origin = ""): Promise<Response> {
  const uid = String(data.localId ?? "");
  const idToken = String(data.idToken ?? "");
  const refreshToken = String(data.refreshToken ?? "");
  const expiresIn = Math.max(0, Number(data.expiresIn ?? 3600));
  let email = String(data.email ?? "").toLowerCase();
  if (!email && idToken.split(".").length === 3) {
    try { email = String((JSON.parse(decoder.decode(b64urlBytes(idToken.split(".")[1]))) as JsonMap).email ?? "").toLowerCase(); }
    catch { /* Firebase response validation below will reject an absent email. */ }
  }
  if (!uid || !idToken || !refreshToken || !email) throw new Error("auth_response_invalid");
  await bindDevice(env, uid, deviceId, newAccount);
  const profile = await ensureProfile(env, uid, email, preferredName);
  const expiresAt = Date.now() + expiresIn * 1000;
  return jsonResponse({ response: {
    access_token: idToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    scope: "user",
    expires_in: expiresIn,
    expires: expiresAt,
    data: legacyUser(profile, uid, email, origin),
    id: profile.legacyId,
  } });
}

async function refreshFirebaseToken(env: Env, refreshToken: string): Promise<JsonMap | null> {
  const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await response.json().catch(() => ({})) as JsonMap;
  return response.ok ? {
    localId: data.user_id,
    email: data.email,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  } : null;
}

async function writeProfile(env: Env, uid: string, profile: JsonMap, createOnly = false): Promise<void> {
  const documentName = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/profiles/${uid}`;
  const query = createOnly ? "?currentDocument.exists=false" : "?updateMask.fieldPaths=displayName&updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=avatarRevision&updateMask.fieldPaths=email&updateMask.fieldPaths=fcmToken";
  const result = await firestoreRequest(env, `/profiles/${encodeURIComponent(uid)}${query}`, {
    method: "PATCH",
    body: JSON.stringify(firestoreDocument(documentName, profile)),
  });
  if (!result.ok) throw new Error(result.status === 409 ? "profile_exists" : "firestore_write_failed");
}

async function readJson(request: Request): Promise<JsonMap> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new Error("body_too_large");
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_BODY_BYTES) throw new Error("body_too_large");
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  let value: unknown;
  if (!raw) value = {};
  else if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(raw);
    value = Object.fromEntries(form.entries());
  } else value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_body");
  return value as JsonMap;
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const packed = url.searchParams.get("json");
  if (packed) {
    try {
      if (packed.length > MAX_BODY_BYTES) return error(413, "بيانات البحث كبيرة جداً.");
      const values = JSON.parse(packed.replace(/(:\s*)(favorites_with_user|plan_to_watch|watched|watching|dropped)(\s*[,}])/g, '$1"$2"$3')) as JsonMap;
      if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("invalid_query");
      for (const [key, value] of Object.entries(values)) {
        if (value !== null && typeof value === "object") throw new Error("invalid_query");
        url.searchParams.set(key, String(value ?? ""));
      }
      url.searchParams.delete("json");
      request = new Request(url, request);
    } catch { return error(400, "صيغة البحث غير صالحة."); }
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  if (url.pathname === "/health" && request.method === "GET") return jsonResponse({ status: "ok", mode: "cloudflare-worker", version: "0.1.0" });

  if (url.pathname === "/manga-app-api/create-account-by-email" && request.method === "POST") {
    if (!env.FIREBASE_WEB_API_KEY) return error(503, "إعدادات تسجيل الدخول غير مكتملة.");
    let body: JsonMap;
    try { body = await readJson(request); } catch { return error(400, "بيانات إنشاء الحساب غير صالحة."); }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const confirm = typeof body.confirm_password === "string" ? body.confirm_password : "";
    const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
    const deviceId = request.headers.get("X-Device-Id") ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(400, "أدخل بريداً صالحاً.");
    if (password.length < 8 || password.length > 256) return error(400, "كلمة المرور من 8 إلى 256 حرفاً.");
    if (password !== confirm) return error(400, "كلمتا المرور غير متطابقتين.");
    if (!fullName || fullName.length > 80) return error(400, "أدخل اسماً من حرف إلى 80 حرفاً.");
    if (!/^[a-f0-9]{64}$/.test(deviceId)) return error(400, "حدّث التطبيق لإرسال معرّف الجهاز الصحيح.");
    const limited = await authLimits(request, env, [["register_ip", request.headers.get("CF-Connecting-IP") ?? "unknown", 5, 3600], ["register_device", deviceId, 3, 3600]]);
    if (limited) return limited;
    try {
      const { response, data } = await firebaseAuth(env, "accounts:signUp", { email, password, displayName: fullName, returnSecureToken: true });
      if (!response.ok) return authError(data);
      try { return await legacyAuthResponse(env, data, fullName, deviceId, true, url.origin); }
      catch (e) {
        if (e instanceof Error && e.message === "device_already_bound") {
          await firebaseAuth(env, "accounts:delete", { idToken: String(data.idToken ?? "") });
          return error(403, "هذا الجهاز مرتبط بحساب واحد. سجّل الدخول بحسابك الحالي.");
        }
        if (e instanceof Error && e.message === "device_required") return error(400, "حدّث التطبيق لإرسال معرّف الجهاز الصحيح.");
        return error(503, "تعذر تجهيز الحساب حالياً.");
      }
    } catch {
      return error(503, "تعذر إنشاء الحساب حالياً.");
    }
  }

  if (url.pathname === "/manga-app-api/check-email" && request.method === "POST") {
    if (!env.FIREBASE_WEB_API_KEY) return error(503, "إعدادات تسجيل الدخول غير مكتملة.");
    let body: JsonMap;
    try { body = await readJson(request); } catch { return error(400, "البريد غير صالح."); }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(400, "أدخل بريداً صالحاً.");
    const deviceId = request.headers.get("X-Device-Id") ?? "";
    if (!/^[a-f0-9]{64}$/.test(deviceId)) return error(400, "حدّث التطبيق لإرسال معرّف الجهاز الصحيح.");
    const limited = await authLimits(request, env, [["email_check_device", deviceId, 30, 300]]);
    if (limited) return limited;
    try {
      const { response, data } = await firebaseAuth(env, "accounts:createAuthUri", { identifier: email, continueUri: `${url.origin}/health`, returnIdpCredential: false });
      if (!response.ok) return authError(data);
      return data.registered === true ? jsonResponse({ response: "exists" }) : error(404, "هذا البريد غير مسجل.");
    } catch { return error(503, "تعذر التحقق من البريد حالياً."); }
  }

  if (url.pathname === "/manga-app-api/forgot-password" && request.method === "POST") {
    if (!env.FIREBASE_WEB_API_KEY) return error(503, "إعدادات تسجيل الدخول غير مكتملة.");
    let body: JsonMap;
    try { body = await readJson(request); } catch { return error(400, "البريد غير صالح."); }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(400, "أدخل بريداً صالحاً.");
    const limited = await authLimits(request, env, [["password_reset_email", email, 3, 3600]]);
    if (limited) return limited;
    try {
      const { response, data } = await firebaseAuth(env, "accounts:sendOobCode", { requestType: "PASSWORD_RESET", email });
      if (!response.ok && (data.error as JsonMap | undefined)?.message !== "EMAIL_NOT_FOUND") return authError(data);
      return jsonResponse({ response: { success: true } });
    } catch { return error(503, "تعذر إرسال رابط الاستعادة حالياً."); }
  }

  if (url.pathname === "/manga-app-api/get-android-app-version" && request.method === "GET") {
    return jsonResponse({ response: { configuration_id: 1, version: "2.0.2", android_app_version_optional: "2.0.2", android_app_note: "", link: "" } });
  }

  if (url.pathname === "/manga-app-api/manga-oauth" && request.method === "POST") {
    if (!env.FIREBASE_WEB_API_KEY) return error(503, "إعدادات تسجيل الدخول غير مكتملة.");
    let body: JsonMap;
    try { body = await readJson(request); } catch { return error(400, "بيانات الدخول غير صالحة."); }
    const email = typeof body.username === "string" ? body.username.trim().toLowerCase() : typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const deviceId = request.headers.get("X-Device-Id") ?? "";
    if (!email || !password) return error(400, "أدخل البريد وكلمة المرور.");
    if (!/^[a-f0-9]{64}$/.test(deviceId)) return error(400, "حدّث التطبيق لإرسال معرّف الجهاز الصحيح.");
    const limited = await authLimits(request, env, [["login_device", deviceId, 10, 300], ["login_email", email, 10, 300]]);
    if (limited) return limited;
    try {
      const { response, data } = await firebaseAuth(env, "accounts:signInWithPassword", { email, password, returnSecureToken: true });
      if (!response.ok) return authError(data);
      try { return await legacyAuthResponse(env, data, undefined, deviceId, false, url.origin); }
      catch (e) {
        if (e instanceof Error && e.message === "device_already_bound") return error(403, "هذا الجهاز مرتبط بحساب آخر.");
        if (e instanceof Error && e.message === "device_required") return error(400, "حدّث التطبيق لإرسال معرّف الجهاز الصحيح.");
        return error(503, "تعذر تجهيز الحساب حالياً.");
      }
    } catch {
      return error(503, "تعذر تسجيل الدخول حالياً.");
    }
  }

  if (url.pathname === "/manga-app-api/create-account-by-google" && request.method === "POST") {
    if (!env.FIREBASE_WEB_API_KEY) return error(503, "إعدادات تسجيل الدخول غير مكتملة.");
    let body: JsonMap;
    try { body = await readJson(request); } catch { return error(400, "بيانات تسجيل Google غير صالحة."); }
    const googleIdToken = typeof body.google_access_token === "string" ? body.google_access_token : "";
    const deviceId = request.headers.get("X-Device-Id") ?? String(body.device_id ?? "");
    if (googleIdToken.length < 100 || googleIdToken.length > 16_384 || googleIdToken.split(".").length !== 3) return error(400, "تعذر التحقق من حساب Google.");
    if (!/^[a-f0-9]{64}$/.test(deviceId)) return error(400, "حدّث التطبيق لإرسال معرّف الجهاز الصحيح.");
    const limited = await authLimits(request, env, [["google_login_device", deviceId, 10, 300]]);
    if (limited) return limited;
    try {
      const postBody = new URLSearchParams({ id_token: googleIdToken, providerId: "google.com" }).toString();
      const { response, data } = await firebaseAuth(env, "accounts:signInWithIdp", {
        requestUri: `https://${env.FIREBASE_PROJECT_ID}.firebaseapp.com/__/auth/handler`,
        postBody,
        returnIdpCredential: true,
        returnSecureToken: true,
      });
      if (!response.ok) return authError(data);
      try { return await legacyAuthResponse(env, data, undefined, deviceId, data.isNewUser === true, url.origin); }
      catch (e) {
        if (e instanceof Error && e.message === "device_already_bound") {
          if (data.isNewUser === true && typeof data.idToken === "string") await firebaseAuth(env, "accounts:delete", { idToken: data.idToken });
          return error(403, "هذا الجهاز مرتبط بحساب آخر.");
        }
        if (e instanceof Error && e.message === "device_required") return error(400, "حدّث التطبيق لإرسال معرّف الجهاز الصحيح.");
        return error(503, "تعذر تجهيز حساب Google حالياً.");
      }
    } catch { return error(503, "تعذر تسجيل الدخول عبر Google حالياً."); }
  }

  if (url.pathname === "/oauth" && request.method === "POST") {
    if (!env.FIREBASE_WEB_API_KEY) return error(503, "إعدادات تسجيل الدخول غير مكتملة.");
    let body: JsonMap;
    try { body = await readJson(request); } catch { return error(400, "بيانات تجديد الجلسة غير صالحة."); }
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
    const deviceId = request.headers.get("X-Device-Id") ?? "";
    if (!refreshToken) return error(401, "جلسة الدخول غير صالحة.");
    if (!/^[a-f0-9]{64}$/.test(deviceId)) return error(400, "حدّث التطبيق لإرسال معرّف الجهاز الصحيح.");
    const limited = await authLimits(request, env, [["refresh_device", deviceId, 30, 300]]);
    if (limited) return limited;
    try {
      const refreshed = await refreshFirebaseToken(env, refreshToken);
      if (!refreshed) return error(401, "انتهت صلاحية الجلسة، سجّل الدخول مجدداً.");
      try { return await legacyAuthResponse(env, refreshed, undefined, deviceId, false, url.origin); }
      catch (e) {
        if (e instanceof Error && e.message === "device_already_bound") return error(403, "هذه الجلسة مرتبطة بجهاز آخر.");
        if (e instanceof Error && e.message === "device_required") return error(400, "حدّث التطبيق لإرسال معرّف الجهاز الصحيح.");
        return error(503, "تعذر تجديد الجلسة حالياً.");
      }
    } catch {
      return error(503, "تعذر تجديد الجلسة حالياً.");
    }
  }

  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_WEB_API_KEY) return error(503, "إعدادات الخادم غير مكتملة.");
  const publicSourcePath = url.pathname.startsWith("/source-image/") || /^\/reader\/\d+$/.test(url.pathname) ||
    ["/manga-app-api/get-all-published-manga", "/manga-app-api/get-published-genres", "/manga-app-api/get-published-manga-details-info", "/manga-app-api/get-published-manga-chapter-pages", "/manga-app-api/download-chapter-as-zip"].includes(url.pathname);
  const personalSourceList = url.pathname === "/manga-app-api/get-all-published-manga" && /favorites|watching|watched|dropped|plan[_-]to[_-]watch/.test(url.searchParams.get("list_type") ?? url.searchParams.get("arg_list_type") ?? "");
  if (publicSourcePath && !personalSourceList) {
    const publicSourceResponse = await handleSourceRoutes(request, env);
    if (publicSourceResponse) return publicSourceResponse;
  }
  const publicAvatar = /^\/avatars\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{8,80})$/.exec(url.pathname);
  if (publicAvatar && request.method === "GET") {
    try {
      const image = await firestoreRequest(env, `/avatars/${encodeURIComponent(publicAvatar[1])}`);
      if (!image.ok) return error(404, "الصورة غير موجودة.");
      const doc = await image.json() as JsonMap;
      const data = parseFirestoreDocument(doc);
      if (data.revision !== publicAvatar[2] || typeof data.base64 !== "string") return error(404, "الصورة غير موجودة.");
      const bytes = sanitizeAvatar(Uint8Array.from(atob(data.base64), (char) => char.charCodeAt(0)), String(data.contentType ?? "image/png"));
      return new Response(bytes as unknown as BodyInit, { headers: { "content-type": String(data.contentType ?? "image/png"), "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
    } catch { return error(404, "الصورة غير موجودة."); }
  }
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return error(401, "سجّل الدخول أولاً.");

  let claims: FirebaseClaims;
  try {
    claims = await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID);
  } catch {
    return error(401, "جلسة الدخول غير صالحة أو منتهية.");
  }
  try {
    if (!await sessionIsActive(env, match[1], claims)) return error(401, "انتهت صلاحية الجلسة، سجّل الدخول مجدداً.");
  } catch { return error(503, "تعذر التحقق من الجلسة حالياً."); }

  try { await bindDevice(env, claims.sub, request.headers.get("X-Device-Id") ?? ""); }
  catch (e) {
    if (e instanceof Error && e.message === "device_required") return error(400, "حدّث التطبيق لإرسال معرّف الجهاز الصحيح.");
    if (e instanceof Error && e.message === "device_already_bound") return error(403, "هذا الجهاز مرتبط بحساب آخر.");
    return error(503, "تعذر التحقق من الجهاز حالياً.");
  }

  const mutating = request.method !== "GET" && request.method !== "HEAD" || url.pathname === "/manga-app-api/remove-user-image";
  if (mutating) {
    try {
      const retry = await consumeRateLimit(env, "mutations_user", claims.sub, 60, 60);
      if (retry) return jsonResponse({message: "طلبات كثيرة، حاول بعد قليل.", error: "RequestLimited", retry_after: retry}, 429, {"retry-after": String(retry)});
      if (url.pathname === "/manga-app-api/update-user-image") {
        const imageRetry = await consumeRateLimit(env, "avatar_user", claims.sub, 3, 300);
        if (imageRetry) return jsonResponse({message: "انتظر قليلاً قبل تغيير الصورة مجدداً.", error: "RequestLimited"}, 429, {"retry-after": String(imageRetry)});
      }
    } catch { return error(503, "الحماية مشغولة مؤقتاً، حاول لاحقاً."); }
  }
  const commentResponse = await handleCommentRoutes(request, env, claims);
  if (commentResponse) return commentResponse;
  if (personalSourceList) return await handleSourceRoutes(request, env, claims) ?? error(404, "القائمة غير موجودة.");
  const libraryResponse = await handleLibraryRoutes(request, env, claims);
  if (libraryResponse) return libraryResponse;

  if (url.pathname === "/manga-app-api/get-user-status" && request.method === "GET") {
    const userId = Number(url.searchParams.get("user_id"));
    if (!Number.isSafeInteger(userId) || userId <= 0) return error(400, "رقم الحساب غير صالح.");
    try {
      const link = await firestoreRequest(env, `/legacyUsers/${userId}`);
      if (!link.ok) return error(404, "الحساب غير موجود.");
      const linkData = parseFirestoreDocument(await link.json() as JsonMap);
      const profile = await readProfile(env, String(linkData.uid));
      if (!profile) return error(404, "الحساب غير موجود.");
      const data = legacyUser(profile, String(linkData.uid), "", url.origin);
      data.username = "";
      return jsonResponse({ response: data });
    } catch { return error(503, "تعذر تحميل الحساب حالياً."); }
  }

  if (url.pathname === "/manga-app-api/sync-fcm-tokens" && request.method === "POST") {
    let body: JsonMap;
    try { body = await readJson(request); } catch { return error(400, "بيانات الإشعار غير صالحة."); }
    const fcmToken = String(body.token ?? body.fcm_token ?? "");
    if (fcmToken.length < 20 || fcmToken.length > 4096) return error(400, "رمز الإشعار غير صالح.");
    try {
      const profile = await ensureProfile(env, claims.sub, claims.email ?? "");
      await writeProfile(env, claims.sub, { ...profile, fcmToken, updatedAt: new Date().toISOString() });
      return jsonResponse({ response: { success: true } });
    } catch { return error(503, "تعذر حفظ إعداد الإشعارات."); }
  }

  if ((url.pathname === "/v1/profile" || url.pathname === "/manga-app-api/get-profile") && request.method === "GET") {
    try {
      const profile = await ensureProfile(env, claims.sub, claims.email ?? "");
      if (url.pathname === "/manga-app-api/get-profile") return jsonResponse({ response: legacyUser(profile, claims.sub, claims.email ?? "", url.origin) });
      return jsonResponse({ uid: claims.sub, email: claims.email ?? "", ...profile });
    } catch {
      return error(503, "تعذر تحميل الملف الشخصي حالياً.");
    }
  }

  if ((url.pathname === "/v1/profile" || url.pathname === "/manga-app-api/update-user-profile") && request.method === "PUT") {
    let body: JsonMap;
    try { body = await readJson(request); } catch (e) { return error(e instanceof Error && e.message === "body_too_large" ? 413 : 400, "بيانات الملف الشخصي غير صالحة."); }
    const nameInput = url.pathname === "/v1/profile" ? body.displayName : body.user_full_name;
    const displayName = typeof nameInput === "string" ? nameInput.trim() : "";
    if (displayName.length < 1 || displayName.length > 80) return error(400, "الاسم يجب أن يكون من حرف إلى 80 حرفاً.");
    try {
      const existing = await ensureProfile(env, claims.sub, claims.email ?? "");
      const data = { ...existing, displayName, updatedAt: new Date().toISOString() };
      await writeProfile(env, claims.sub, data);
      if (url.pathname === "/manga-app-api/update-user-profile") {
        return jsonResponse({ response: { success: true, data: legacyUser(data, claims.sub, claims.email ?? "", url.origin) } });
      }
      return jsonResponse({ uid: claims.sub, email: claims.email ?? "", ...data });
    } catch {
      return error(503, "تعذر حفظ الملف الشخصي حالياً.");
    }
  }

  if (url.pathname === "/manga-app-api/update-user-image" && request.method === "POST") {
    try {
      const form = await request.formData();
      const image = form.get("user_image");
      if (!(image instanceof File)) return error(400, "اختر صورة للحساب.");
      if (!image.size || image.size > 700_000) return error(413, "حجم الصورة بعد ضغطها يجب ألا يتجاوز 700 كيلوبايت.");
      let bytes: Uint8Array = new Uint8Array(await image.arrayBuffer());
      const contentType = image.type.toLowerCase();
      const valid = (contentType === "image/png" && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) ||
        (contentType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
        (contentType === "image/webp" && decoder.decode(bytes.slice(0, 4)) === "RIFF" && decoder.decode(bytes.slice(8, 12)) === "WEBP");
      if (!valid) return error(400, "اختر صورة PNG أو JPEG أو WebP.");
      try { bytes = sanitizeAvatar(bytes, contentType); }
      catch { return error(400, "الصورة غير صالحة أو أبعادها أكبر من المسموح."); }
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const revision = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
      const avatarPath = `avatars/${claims.sub}`;
      const avatarName = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${avatarPath}`;
      const saved = await firestoreRequest(env, `/${avatarPath}`, { method: "PATCH", body: JSON.stringify(firestoreDocument(avatarName, { revision, contentType, base64: btoa(binary), updatedAt: new Date().toISOString() })) });
      if (!saved.ok) return error(503, "تعذر حفظ الصورة حالياً.");
      const profile = await ensureProfile(env, claims.sub, claims.email ?? "");
      const updated = { ...profile, avatarRevision: revision, updatedAt: new Date().toISOString() };
      await writeProfile(env, claims.sub, updated);
      return jsonResponse({ response: { success: true, data: legacyUser(updated, claims.sub, claims.email ?? "", url.origin) } });
    } catch { return error(503, "تعذر رفع الصورة حالياً."); }
  }

  if (url.pathname === "/manga-app-api/change-password" && request.method === "POST") {
    let body: JsonMap;
    try { body = await readJson(request); } catch { return error(400, "بيانات كلمة المرور غير صالحة."); }
    const current = String(body.current_password ?? "");
    const next = String(body.new_password ?? "");
    const confirm = String(body.confirm_password ?? "");
    if (next.length < 8 || next.length > 256 || next !== confirm) return error(400, "كلمة المرور الجديدة غير صالحة.");
    if (!claims.email || current.length > 256) return error(403, "كلمة المرور الحالية غير صحيحة.");
    try {
      const verified = await firebaseAuth(env, "accounts:signInWithPassword", { email: claims.email, password: current, returnSecureToken: true });
      if (!verified.response.ok) return error(403, "كلمة المرور الحالية غير صحيحة.");
      const changed = await firebaseAuth(env, "accounts:update", { idToken: String(verified.data.idToken ?? ""), password: next, returnSecureToken: true });
      if (!changed.response.ok) return authError(changed.data);
      const deviceId = request.headers.get("X-Device-Id") ?? "";
      try { return await legacyAuthResponse(env, changed.data, undefined, deviceId, false, url.origin); }
      catch (e) {
        if (e instanceof Error && e.message === "device_required") return error(400, "حدّث التطبيق لإرسال معرّف الجهاز الصحيح.");
        return error(503, "تم تغيير كلمة المرور لكن تعذر تحديث الجلسة.");
      }
    } catch { return error(503, "تعذر تغيير كلمة المرور حالياً."); }
  }

  if (url.pathname === "/manga-app-api/remove-user-image" && request.method === "GET") {
    try {
      await firestoreRequest(env, `/avatars/${encodeURIComponent(claims.sub)}`, { method: "DELETE" });
      const profile = await ensureProfile(env, claims.sub, claims.email ?? "");
      const updated = { ...profile, avatarRevision: "", updatedAt: new Date().toISOString() };
      await writeProfile(env, claims.sub, updated);
      return jsonResponse({ response: { success: true } });
    } catch { return error(503, "تعذر حذف الصورة حالياً."); }
  }

  return error(404, "المسار غير موجود.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    try {
      const guarded = await protectRequest(request, env);
      const response = guarded instanceof Response ? guarded : await handle(guarded, env);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "no-referrer");
      headers.set("strict-transport-security", "max-age=31536000");
      if (!headers.has("content-security-policy")) headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch {
      const response = error(500, "حدث خطأ داخلي.");
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "no-referrer");
      headers.set("strict-transport-security", "max-age=31536000");
      return new Response(response.body, { status: response.status, headers });
    }
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await refreshSourceIndexes(env);
    if (controller.cron !== "17 3 * * *") return;
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'rateLimits/%' AND CAST(json_extract(fields, '$.updatedAt.integerValue') AS INTEGER) < ?1")
      .bind(cutoff).run();
    await env.DB.prepare("DELETE FROM source_response_cache WHERE expires_at < ?1").bind(cutoff).run();
  },
};
