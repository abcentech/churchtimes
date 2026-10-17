// Actual temporary Vite build and Node host. Anonymous CMS transport is a labelled
// local STUB that counts requests; this is not the owner's staging or CMS evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,readdir,rename,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {publicHostConfig} from '../tools/public-host.mjs';
import {publicHostHealth} from '../tools/public-host-health.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const origin='https://synthetic-staging.example.test';
const map=to=>JSON.stringify({version:'sha256:syntheticmap',generatedAt:'2026-10-17T00:00:00.000Z',count:2,rules:[
 {from:'/synthetic-old/',to,status:301,source:'manual'},
 {from:'/synthetic-gone/',status:410,source:'manual'},
]});
const waitFor=async predicate=>{for(let n=0;n<200;n++){if(await predicate())return;await new Promise(done=>setTimeout(done,50));}throw new Error('Expected local smoke event did not occur.');};
test('draft runtime rejects unsafe host/origin/private-map configuration and preserves staging defaults',()=>{
 const config=publicHostConfig({PUBLIC_SITE_URL:origin});assert.equal(config.host,'127.0.0.1');assert.equal(config.options.indexable,false);assert.equal(config.options.articlePathTemplate,'/reports/{slug}/');
 for(const env of [{HOST:'0.0.0.0'},{PORT:'not-a-port'},{PUBLIC_SITE_URL:'https://synthetic.example.test/path/'},{PUBLIC_SITE_URL:'http://outside.example.test'},{PUBLIC_REDIRECTS_FILE:'relative-private-map.json'},{PUBLIC_DIST:'/tmp/synthetic-build',PUBLIC_REDIRECTS_FILE:'/tmp/synthetic-build/private-map.json'},{PUBLIC_HOST_SHUTDOWN_MS:'0'}])assert.throws(()=>publicHostConfig({PUBLIC_SITE_URL:origin,...env}));
});
test('documented env-file startup serves staging health, ads and headers; SIGHUP keeps last good rules and SIGTERM stops cleanly',{skip:process.platform==='win32'?'This draft Linux host kit requires POSIX signals.':false},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'public-host-kit-'));let child;
 t.after(async()=>{if(child&&child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}await rm(directory,{recursive:true,force:true});});
 const dist=join(directory,'build');
 await build({root,logLevel:'silent',build:{outDir:dist,emptyOutDir:true}});
 // Prepare the actual temporary Vite output in the public host's documented
 // /site asset layout, without writing tracked Pages exports or root dist.
 await mkdir(join(dist,'site'));
 for(const file of await readdir(dist))if(!['index.html','site'].includes(file))await rename(join(dist,file),join(dist,'site',file));
 await writeFile(join(dist,'index.html'),(await readFile(join(dist,'index.html'),'utf8')).replace(/(src|href)="\.\//g,'$1="./site/'));
 const selectedBuild=join(directory,'selected-build');await symlink(dist,selectedBuild,'dir');
 const privateMap=join(directory,'private-redirects.json');await writeFile(privateMap,map('/about/'),{mode:0o600});
 let cmsCalls=0;const cms=createServer((_req,res)=>{cmsCalls++;res.writeHead(503,{'Content-Type':'application/json'});res.end('{}');});
 await new Promise(done=>cms.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>cms.close(done)));
 const envFile=join(directory,'synthetic.env');
 await writeFile(envFile,[`HOST=127.0.0.1`,`PORT=0`,`PUBLIC_DIST=${selectedBuild}`,`PUBLIC_SITE_URL=${origin}`,`PUBLIC_CMS_URL=http://127.0.0.1:${cms.address().port}`,`PUBLIC_INDEXABLE=false`,`PUBLIC_ARTICLE_PATH_TEMPLATE=/reports/{slug}/`,`PUBLIC_REDIRECTS_FILE=${privateMap}`,`PUBLIC_ADS_TXT_LINE=example.test, synthetic-publisher, DIRECT`,`PUBLIC_HOST_SHUTDOWN_MS=1000`].join('\n')+'\n',{mode:0o600});
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('PUBLIC_')||['PORT','HOST','REDIRECT_ALLOWED_HOSTS'].includes(key))delete env[key];
 child=spawn(process.execPath,['--env-file='+envFile,'tools/public-host.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
 const exited=once(child,'exit');let earlyExit=false;exited.then(()=>earlyExit=true);
 await waitFor(()=>{if(earlyExit)throw new Error('Local smoke host exited before readiness: '+errors);return output.includes('public_host_listening');});
 const port=JSON.parse(output.split('\n').find(line=>line.includes('public_host_listening'))).port,url='http://127.0.0.1:'+port;
 assert.equal(await publicHostHealth({env:{HOST:'127.0.0.1',PORT:String(port)}}),true);
 const health=spawn(process.execPath,['--env-file='+envFile,'tools/public-host-health.mjs'],{cwd:root,env:{...env,HOST:'127.0.0.1',PORT:String(port)},stdio:'pipe'});assert.equal((await once(health,'exit'))[0],0);
 assert.equal(cmsCalls,0,'cheap health must not contact the CMS STUB');
 for(const method of ['GET','HEAD']) {
  const ad=await fetch(url+'/ads.txt',{method});assert.equal(ad.status,200);assert.equal(ad.headers.get('x-content-type-options'),'nosniff');assert.equal(ad.headers.get('cache-control'),'public, max-age=60');assert.equal(ad.headers.get('content-type'),'text/plain; charset=utf-8');assert.equal(await ad.text(),method==='HEAD'?'':'example.test, synthetic-publisher, DIRECT\n');
 }
 // Selecting a different release must not change this process's pinned build.
 const otherBuild=join(directory,'other-build');await mkdir(otherBuild);await rm(selectedBuild);await symlink(otherBuild,selectedBuild,'dir');
 const home=await fetch(url+'/');assert.equal(home.status,200);assert.equal(home.headers.get('cache-control'),'no-store');assert.equal(home.headers.get('x-robots-tag'),'noindex,nofollow');const html=await home.text();
 const asset=html.match(/<script[^>]+src="([^\"]+\.js)"/)?.[1];assert.ok(asset);const compiled=await fetch(new URL(asset,url+'/'));assert.equal(compiled.status,200);assert.equal(compiled.headers.get('cache-control'),'public, max-age=31536000, immutable');await compiled.arrayBuffer();
 const old=()=>fetch(url+'/synthetic-old',{redirect:'manual'});
 assert.equal((await old()).headers.get('location'),'/about/');
 const gone=await fetch(url+'/synthetic-gone/',{redirect:'manual'});assert.equal(gone.status,410);assert.equal(gone.headers.get('location'),null);
 // Atomic same-directory replacement, exactly the operational reload workflow.
 const next=privateMap+'.next';await writeFile(next,map('/contact/'));await rename(next,privateMap);child.kill('SIGHUP');
 await waitFor(async()=>(await old()).headers.get('location')==='/contact/');
 await writeFile(next,'{"invalid":"synthetic map"}');await rename(next,privateMap);child.kill('SIGHUP');
 await waitFor(()=>output.includes('public_redirect_refresh_failed')||output.includes('public_redirect_refresh_finished')&&errors.includes('public_redirect_refresh_failed'));
 assert.equal((await old()).headers.get('location'),'/contact/','invalid generation retains the last good map');
 const checks=join(directory,'synthetic-cutover-checks.json');
 await writeFile(checks,JSON.stringify([{path:'/synthetic-old',expectedStatus:301,expectedTitle:'Contact the newsroom — Church Times Nigeria'},{path:'/synthetic-gone/',expectedStatus:410}]),{mode:0o600});
 const checker=spawn(process.execPath,['tools/check-redirects.mjs','--target',url,'--urls',checks,'--rate','2','--quiet'],{cwd:root,env,stdio:'pipe'});let checkerOutput='';checker.stdout.on('data',chunk=>checkerOutput+=chunk);
 assert.equal((await once(checker,'exit'))[0],0);assert.deepEqual(JSON.parse(checkerOutput),{total:2,passed:2,failed:0});
 assert.doesNotMatch(checkerOutput,/synthetic-old|synthetic-gone|Contact the newsroom/);
 const refused=spawn(process.execPath,['tools/check-redirects.mjs','--urls',checks,'--quiet'],{cwd:root,env,stdio:'pipe'});assert.equal((await once(refused,'exit'))[0],1);
 const systemd=spawnSync('systemd-analyze',['--version'],{stdio:'pipe'});
 if(systemd.status===0) {
  // Syntax-only disposable copy: this sandbox has Node outside /usr/bin.
  const unit=join(directory,'churchtimes-public.service');
  await writeFile(unit,(await readFile(join(root,'deploy/public-host/churchtimes-public.service'),'utf8')).replace('/usr/bin/node',process.execPath));
  const verified=spawnSync('systemd-analyze',['verify',unit],{encoding:'utf8'});assert.equal(verified.status,0,verified.stderr);
 }

 assert.equal(cmsCalls,0,'file-backed smoke routes must not contact the CMS STUB');
 child.kill('SIGTERM');const [code,signal]=await exited;assert.equal(code,0);assert.equal(signal,null);assert.match(output,/public_host_stopped/);
 assert.doesNotMatch(output+errors,/synthetic-publisher|synthetic-old|private-redirects/,'runtime logs omit map paths and publisher values');
});
