type Limiter = { limit(input: {key: string}): Promise<{success: boolean}> };
export interface SecurityBindings {
  REQUEST_LIMITER: Limiter;
  CATALOG_LIMITER: Limiter;
  DOWNLOAD_LIMITER: Limiter;
}

function reject(status: number, message: string): Response {
  return new Response(JSON.stringify({message, error: message}), {
    status, headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(status === 429 ? {"retry-after": "60"} : {})},
  });
}

/** Bound actual streamed bytes, including requests without Content-Length. */
export async function protectRequest(request: Request, env: SecurityBindings): Promise<Request | Response> {
  const url = new URL(request.url);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return reject(400, "استخدم اتصالاً مشفراً.");
  if (request.url.length > 8192) return reject(414, "رابط الطلب طويل جداً.");
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method)) return reject(405, "طريقة الطلب غير مدعومة.");
  if (request.method === "OPTIONS") return request;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.REQUEST_LIMITER.limit({key: ip})).success) return reject(429, "طلبات كثيرة، حاول بعد قليل.");
  if (url.pathname === "/manga-app-api/download-chapter-as-zip") {
    if (!(await env.DOWNLOAD_LIMITER.limit({key: ip})).success) return reject(429, "انتظر قليلاً قبل تنزيل فصل آخر.");
  } else if (url.pathname.startsWith("/reader/") || /\/get-(all-published|published-)/.test(url.pathname)) {
    if (!(await env.CATALOG_LIMITER.limit({key: ip})).success) return reject(429, "طلبات قراءة كثيرة، حاول بعد قليل.");
  }
  if (!request.body) return request;
  const avatar = url.pathname === "/manga-app-api/update-user-image";
  const cap = avatar ? 750_000 : 16_384;
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > cap)) return reject(413, "حجم الطلب أكبر من المسموح.");
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (avatar && !type.startsWith("multipart/form-data;")) return reject(415, "صيغة الطلب غير مدعومة.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) { void reader.cancel(); return reject(413, "حجم الطلب أكبر من المسموح."); }
      chunks.push(value);
    }
  } catch { return reject(400, "تعذر قراءة الطلب."); }
  // Cloudflare exposes an empty stream for native DELETE requests with Content-Length: 0.
  // Such requests carry their IDs in the query and legitimately have no Content-Type.
  // Check actual bytes rather than trusting the declared length to bypass validation.
  if (!avatar && size > 0 && !["application/json", "application/x-www-form-urlencoded"].some(value => type.startsWith(value))) return reject(415, "صيغة الطلب غير مدعومة.");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request, {body: bytes});
}
