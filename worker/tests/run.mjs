import {buildSync} from 'esbuild';
import {spawnSync} from 'node:child_process';
for(const suite of ['security','source']) {
 buildSync({entryPoints:[`tests/${suite}.test.ts`],bundle:true,platform:'node',format:'esm',outfile:`.wrangler/${suite}.test.mjs`});
 const result=spawnSync(process.execPath,[`.wrangler/${suite}.test.mjs`],{stdio:'inherit'});
 if(result.status!==0)process.exit(result.status??1);
}
