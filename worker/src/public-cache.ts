// Only public source metadata goes here. Never cache profiles, tokens or comments.
const local=new WeakMap<object,Map<string,{until:number,value:Record<string,unknown>}>>();
export async function publicSourceCache(scope:object,key:string,loader:()=>Promise<Record<string,unknown>>,ttl=900):Promise<Record<string,unknown>> {
  let memory=local.get(scope);
  if(!memory) {memory=new Map();local.set(scope,memory);}
  let saved=memory.get(key);
  if(saved && saved.until>Date.now()) return saved.value;
  const edge=typeof caches==='undefined'?undefined:(caches as CacheStorage & {default:Cache}).default;
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),b=>b.toString(16).padStart(2,'0')).join('');
  const request=new Request('https://manga-source-cache.invalid/v2/'+hash);
  if(!saved && edge) {
    try {
      const hit=await edge.match(request);
      if(hit) saved={until:Number(hit.headers.get('x-source-until')),value:await hit.json() as Record<string,unknown>};
      if(saved && saved.until>Date.now()) {memory.set(key,saved);return saved.value;}
    } catch { /* upstream remains available when an edge cache is cold */ }
  }
  try {
    const value=await loader(),text=JSON.stringify(value),until=Date.now()+ttl*1000;
    if(text.length<=1_000_000) {
      if(memory.size>=8) memory.delete(memory.keys().next().value!);
      memory.set(key,{until,value});
      if(edge) try {await edge.put(request,new Response(text,{headers:{'content-type':'application/json','cache-control':'public, max-age=604800','x-source-until':String(until)}}));} catch { /* no database fallback writes */ }
    }
    return value;
  } catch(cause) {if(saved) return saved.value;throw cause;}
}
