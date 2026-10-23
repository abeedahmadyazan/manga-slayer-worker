import { Env, FirebaseClaims, firestoreDocument, firestoreRequest, jsonResponse } from "./index";

type Values = Record<string, unknown>;
const mutationMap: Record<string, { method: "add" | "remove"; kind: string }> = {
  "/manga-app-api/save-manga-to-favorites": { method: "add", kind: "favorites" },
  "/manga-app-api/delete-manga-from-favorites": { method: "remove", kind: "favorites" },
  "/manga-app-api/save-manga-to-plan-to-watch": { method: "add", kind: "plan-to-watch" },
  "/manga-app-api/delete-manga-from-plan-to-watch": { method: "remove", kind: "plan-to-watch" },
  "/manga-app-api/save-manga-to-watched": { method: "add", kind: "watched" },
  "/manga-app-api/delete-manga-from-watched": { method: "remove", kind: "watched" },
  "/manga-app-api/save-manga-to-watching": { method: "add", kind: "watching" },
  "/manga-app-api/delete-manga-from-watching": { method: "remove", kind: "watching" },
  "/manga-app-api/save-manga-to-dropped": { method: "add", kind: "dropped" },
  "/manga-app-api/delete-manga-from-dropped": { method: "remove", kind: "dropped" },
};

function fail(status: number, message: string): Response { return jsonResponse({ message, error: message }, status); }
function valuesOf(value: unknown): number[] {
  const raw = String(value ?? "");
  if (!/^[\d,\s\[\]]+$/.test(raw)) return [];
  const ids = [...new Set(raw.match(/\d+/g)?.map(Number) ?? [])];
  return ids.length <= 30 && ids.every(id => Number.isSafeInteger(id) && id > 0) ? ids : [];
}

async function readFields(request: Request): Promise<Values> {
  const raw = await request.text();
  if (request.headers.get("content-type")?.includes("application/json")) return JSON.parse(raw) as Values;
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

async function updateDoc(env: Env, path: string, fields: Values): Promise<boolean> {
  const name = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const result = await firestoreRequest(env, `/${path}`, { method: "PATCH", body: JSON.stringify(firestoreDocument(name, fields)) });
  return result.ok;
}

async function upsertMany(env: Env, uid: string, kind: string, ids: number[], method: "add" | "remove"): Promise<Response> {
  if (!ids.length) return fail(400, "اختر مانجا.");
  if (method === "add") {
    const prefix = `profiles/${uid}/library/`;
    const count = await env.DB.prepare("SELECT count(*) AS total FROM documents WHERE path >= ?1 AND path < ?2").bind(prefix, prefix + "\uffff").first<{total: number}>();
    if ((count?.total ?? 0) + ids.length > 2000) return fail(409, "وصلت إلى الحد الأقصى للعناوين المحفوظة.");
    for (const id of ids) if (!(await firestoreRequest(env, `/sourceManga/${id}`)).ok) return fail(404, "أحد العناوين غير موجود.");
  }
  for (const id of ids) {
    const path = `profiles/${uid}/library/${kind}_${id}`;
    if (method === "remove") {
      const result = await firestoreRequest(env, `/${path}`, { method: "DELETE" });
      if (!result.ok && result.status !== 404) return fail(503, "تعذر تحديث مكتبتك حالياً.");
    } else if (!await updateDoc(env, path, { mangaId: id, kind, addedAt: new Date().toISOString() })) {
      return fail(503, "تعذر تحديث مكتبتك حالياً.");
    }
  }
  return jsonResponse({ response: { success: true } });
}

export async function handleLibraryRoutes(request: Request, env: Env, claims: FirebaseClaims): Promise<Response | null> {
  const url = new URL(request.url);
  const mutation = mutationMap[url.pathname];
  if (mutation && (request.method === "POST" || request.method === "DELETE")) {
    try {
      const params = await readFields(request);
      const ids = valuesOf(params.manga_ids ?? params.manga_id);
      return await upsertMany(env, claims.sub, mutation.kind, ids, mutation.method);
    } catch { return fail(503, "تعذر تحديث مكتبتك حالياً."); }
  }
  if (url.pathname === "/manga-app-api/save-manga-rating" && request.method === "POST") {
    try {
      const params = await readFields(request);
      const mangaId = valuesOf(params.manga_id)[0] ?? 0;
      const rating = Number(params.manga_rating);
      if (!mangaId || !Number.isInteger(rating) || rating < 1 || rating > 10) return fail(400, "التقييم بين 1 و10.");
      const path = `profiles/${claims.sub}/ratings/${mangaId}`;
      return await updateDoc(env, path, { mangaId, rating, updatedAt: new Date().toISOString() }) ? jsonResponse({ response: { success: true } }) : fail(503, "تعذر حفظ التقييم.");
    } catch { return fail(400, "التقييم غير صالح."); }
  }
  if (url.pathname === "/manga-app-api/save-chapter-watched-history" && request.method === "POST") {
    try {
      const params = await readFields(request);
      const chapterId = valuesOf(params.chapter_id)[0] ?? 0;
      if (!chapterId) return fail(400, "اختر فصلاً.");
      const path = `profiles/${claims.sub}/history/${chapterId}`;
      return await updateDoc(env, path, { chapterId, readAt: new Date().toISOString() }) ? jsonResponse({ response: { success: true } }) : fail(503, "تعذر حفظ سجل القراءة.");
    } catch { return fail(400, "بيانات الفصل غير صالحة."); }
  }
  if (url.pathname === "/manga-app-api/delete-chapter-from-watched-history" && request.method === "DELETE") {
    try {
      const params = await readFields(request);
      const ids = valuesOf(params.chapter_ids ?? params.chapter_id);
      for (const chapterId of ids) await firestoreRequest(env, `/profiles/${claims.sub}/history/${chapterId}`, { method: "DELETE" });
      return jsonResponse({ response: { success: true } });
    } catch { return fail(503, "تعذر تحديث سجل القراءة."); }
  }
  if (url.pathname === "/manga-app-api/change-password" && request.method === "POST") {
    return fail(501, "تغيير كلمة المرور من إعدادات الحساب في صفحة تسجيل الدخول غير مفعّل بعد.");
  }
  return null;
}
