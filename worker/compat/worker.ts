// Keep previously installed APKs working after the account migration.
// No D1, cron jobs, or credentials are attached to this compatibility Worker.
export default {
  async fetch(request:Request):Promise<Response> {
    const old=new URL(request.url);
    const target=new URL(old.pathname+old.search,'https://manga-slayer-api.yz-manga-api-v2.workers.dev');
    try {return await fetch(new Request(target,request),{signal:AbortSignal.timeout(30000),redirect:'manual'});}
    catch {return Response.json({message:'الخدمة مشغولة مؤقتًا، حاول بعد قليل.'},{status:503,headers:{'cache-control':'no-store'}});}
  }
};
