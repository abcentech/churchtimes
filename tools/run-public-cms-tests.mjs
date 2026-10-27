// Creates a disposable local database, boots the real REST handlers, and runs
// browser tests. Only external Turnstile transport is stubbed by the test host.
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtempSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const cmsRequire=createRequire(new URL('../apps/cms/package.json',import.meta.url));
const freePort=()=>new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
let pg;let server;let browser;let build;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exitCode=child=>new Promise(resolve=>child.once('exit',code=>resolve(code ?? 1)));
async function stop(child){if(!child||child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([exitCode(child),wait(15000)]);if(child.exitCode===null)child.kill('SIGKILL');}
const data=mkdtempSync(join(tmpdir(),'churchtimes-public-cms-'));
const log=createWriteStream(join(data,'rest-host.log'));
try {
  let database=process.env.TEST_DATABASE_URL;
  if(database){const url=new URL(database);if(!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.includes('test'))throw new Error('TEST_DATABASE_URL must identify a disposable loopback test database.');}
  else {
    const {default:EmbeddedPostgres}=await import(pathToFileURL(cmsRequire.resolve('embedded-postgres')).href);
    const port=await freePort();
    pg=new EmbeddedPostgres({databaseDir:join(data,'pg'),port,user:'churchtimes',password:'test-only-public-cms',persistent:false,onLog:()=>{},onError:()=>{}});
    await pg.initialise();await pg.start();await pg.createDatabase('churchtimes_public_test');
    database=`postgres://churchtimes:test-only-public-cms@127.0.0.1:${port}/churchtimes_public_test`;
  }
  const port=await freePort();const url='http://127.0.0.1:'+port;
  const publicPort=await freePort();const ssrPort=await freePort();const aliasPort=await freePort();
  const publicUrl='http://127.0.0.1:'+publicPort;
  const ssrUrl='http://127.0.0.1:'+ssrPort;const aliasUrl='http://127.0.0.1:'+aliasPort;
  const dist=join(data,'public-dist');

  const env={...process.env,NODE_ENV:'test',DATABASE_URL:database,
    PAYLOAD_SECRET:randomBytes(32).toString('hex'),PREVIEW_SECRET:randomBytes(32).toString('hex'),IP_HASH_SALT:randomBytes(32).toString('hex'),
    CMS_PUBLIC_URL:url,CMS_CORS_ORIGINS:publicUrl+','+ssrUrl+','+aliasUrl,CMS_CSRF_ORIGINS:url,PUBLIC_SUBMISSION_ORIGINS:publicUrl+','+aliasUrl,
    TURNSTILE_EXPECTED_ACTION:'submit-story',TURNSTILE_ALLOWED_HOSTNAMES:'127.0.0.1',SUBMISSION_RATE_LIMIT:'100',
    PUBLIC_LEGACY_SAMPLES:process.env.PUBLIC_LEGACY_SAMPLES || 'false',SCHEDULER_ENABLED:'false',PAYLOAD_DB_PUSH:'false',TRUST_PROXY:'false',PUBLIC_CMS_TEST_PORT:String(port),
  };
  // Never inherit a real service credential into a fixture server.
  for(const name of ['TURNSTILE_SECRET_KEY','SMTP_HOST','SMTP_USER','SMTP_PASS'])delete env[name];
  server=spawn(process.execPath,[join(root,'apps/cms/node_modules/tsx/dist/cli.mjs'),'--tsconfig',join(root,'apps/cms/tsconfig.json'),join(root,'tools/public-cms-test-server.ts')],{cwd:join(root,'apps/cms'),env,stdio:['ignore','pipe','pipe']});
  server.stdout.pipe(log);server.stderr.pipe(log);
  let ready=false;
  for(let i=0;i<120;i++){if(server.exitCode!==null)throw new Error('REST host failed; inspect '+join(data,'rest-host.log'));try{const response=await fetch(url+'/__test/fixtures');if(response.ok){ready=true;break;}}catch{}await wait(500);}
  if(!ready)throw new Error('REST host did not become ready; inspect '+join(data,'rest-host.log'));
  console.log('Testing real Payload REST and PostgreSQL; Turnstile script/Siteverify transport are STUBBED.');
  const auditSource=process.env.PUBLIC_AUDIT_SOURCE || root;
  build=spawn(process.execPath,['node_modules/vite/bin/vite.js','build','--outDir',dist],{cwd:process.env.PUBLIC_AUDIT_DIR?auditSource:root,
    env:{...process.env,NODE_ENV:'production',VITE_PUBLIC_CMS_URL:url,VITE_PUBLIC_SITE_URL:'https://staging-public.example.test',VITE_PUBLIC_SUBMISSIONS_URL:'',VITE_PUBLIC_CONTACT_URL:'',VITE_TURNSTILE_SITE_KEY:'1x00000000000000000000AA',VITE_TURNSTILE_ACTION:'submit-story'},stdio:'inherit'});
  if(await exitCode(build)!==0)throw new Error('Compiled public test build failed.');
  if(process.env.PUBLIC_AUDIT_DIR) {
    const {auditPublic}=await import('./audit-public.mjs');
    await auditPublic({cmsUrl:url,dist,output:process.env.PUBLIC_AUDIT_DIR,port:ssrPort,sourceRoot:auditSource});
  } else {
  browser=spawn(process.execPath,['node_modules/@playwright/test/cli.js','test','--config','playwright.cms.config.js',...process.argv.slice(2)],{cwd:root,env:{...process.env,PUBLIC_CMS_TEST_URL:url,PUBLIC_FRONTEND_TEST_URL:publicUrl,PUBLIC_SSR_TEST_URL:ssrUrl,PUBLIC_ALIAS_TEST_URL:aliasUrl,PUBLIC_TEST_DIST:dist},stdio:'inherit'});
  process.exitCode=await exitCode(browser);
  }
} catch(error){console.error(error.message);process.exitCode=1;}
finally{await stop(build);await stop(browser);await stop(server);log.end();if(pg)await pg.stop();}
