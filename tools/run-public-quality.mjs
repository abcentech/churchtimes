// Production build + actual anonymous CMS, never a live/public target.
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
const output=resolve(process.env.PUBLIC_QUALITY_OUTPUT || 'public-quality-results');
await mkdir(output,{recursive:true});
await writeFile(join(output,'quality.json'),JSON.stringify({passed:false,failures:['Quality run did not complete'],startedAt:new Date().toISOString()})+'\n');
const child=spawn(process.execPath,['tools/run-public-cms-tests.mjs'],{stdio:'inherit',env:{...process.env,
  PUBLIC_AUDIT_DIR:output,PUBLIC_QUALITY_GATE:'true',PUBLIC_INDEXABLE:'false',
  PUBLIC_AUDIT_SOURCE:'',PUBLIC_AUDIT_ONLY_SCREENSHOTS:'false',PUBLIC_AUDIT_SCREENSHOTS:'false',
  PUBLIC_ADS_TXT_LINE:'',PUBLIC_SEARCH_CONSOLE_VERIFICATION:'',PUBLIC_LEGACY_SAMPLES:'false',
}});
child.once('error',()=>{console.error('Could not start the public quality gate');process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code ?? 1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
