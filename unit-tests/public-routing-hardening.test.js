import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fetchPublishedPage} from '../src/lib/published-articles.js';
import {createLookupCache} from '../tools/public-lookup-cache.mjs';
import {publicHostConfig} from '../tools/public-host.mjs';
import {changedPublicFiles,publicBuildMode} from '../tools/public-build-policy.mjs';

test('category listing matches primary OR additional category (nested under and)',async()=>{
  let request;
  const fetchImpl=async url=>{request=new URL(url);return {ok:true,json:async()=>({docs:[]})};};
  await fetchPublishedPage({baseUrl:'https://cms.example.test',categoryId:'7',fetchImpl});
  const p=request.searchParams;
  assert.equal(p.get('where[and][0][or][0][category][equals]'),'7');
  assert.equal(p.get('where[and][0][or][1][categories][equals]'),'7');
  assert.equal(p.get('where[category][equals]'),null);
  assert.equal(p.get('where[status][equals]'),'published');
  assert.equal(p.get('where[or][0][title][like]'),null);
  await assert.rejects(()=>fetchPublishedPage({baseUrl:'https://cms.example.test',categoryId:'news',fetchImpl}),/numeric IDs/);
});

test('lookup cache: positive and negative TTLs, no error caching, bounded, de-duplicated',async()=>{
  let time=0,calls=0;
  const cache=createLookupCache({ttlMs:30000,negativeTtlMs:10000,max:2,now:()=>time});
  const load=value=>async()=>{calls++;return value;};
  assert.equal(await cache.get('a',load('A')),'A');assert.equal(await cache.get('a',load('X')),'A');assert.equal(calls,1);
  time=29999;assert.equal(await cache.get('a',load('X')),'A');time=30001;assert.equal(await cache.get('a',load('B')),'B');
  assert.equal(await cache.get('n',load(null)),null);assert.equal(await cache.get('n',load('Z')),null);
  time+=10001;assert.equal(await cache.get('n',load('Z')),'Z');
  const failing=async()=>{throw new Error('down');};
  await assert.rejects(()=>cache.get('e',failing),/down/);
  assert.equal(await cache.get('e',load('ok')),'ok');
  for(const key of ['k1','k2','k3'])await cache.get(key,load(key));
  assert.ok(cache.size<=2);
  let concurrent=0;const slow=async()=>{concurrent++;await new Promise(r=>setTimeout(r,5));return 'S';};
  const results=await Promise.all([cache.get('s',slow),cache.get('s',slow),cache.get('s',slow)]);
  assert.deepEqual(results,['S','S','S']);assert.equal(concurrent,1);
});

test('a loopback PUBLIC_CMS_URL is refused when the site is https, allowed for local rehearsal',()=>{
  const base={PUBLIC_SITE_URL:'https://public.example.test'};
  for(const cms of ['http://127.0.0.1:3000','http://localhost:3000','http://[::1]:3000','http://cms.localhost:3000'])
    assert.throws(()=>publicHostConfig({...base,PUBLIC_CMS_URL:cms}),/not loopback/);
  assert.doesNotThrow(()=>publicHostConfig({...base,PUBLIC_CMS_URL:'https://cms.example.test'}));
  assert.doesNotThrow(()=>publicHostConfig({...base,PUBLIC_CMS_URL:'http://127.0.0.1:3000',PUBLIC_HOST_ALLOW_LOOPBACK_CMS:'true'}));
  assert.doesNotThrow(()=>publicHostConfig({PUBLIC_SITE_URL:'http://127.0.0.1:5373',PUBLIC_CMS_URL:'http://127.0.0.1:3000'}));
});

test('build policy catches a rename out of site/ or index.html',async t=>{
  const root=await mkdtemp(join(tmpdir(),'public-policy-rename-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
  const commit=m=>{git('add','-A');git('-c','user.name=t','-c','user.email=t@example.test','commit','-m',m);return git('rev-parse','HEAD');};
  git('init');await mkdir(join(root,'site'));
  await writeFile(join(root,'site','bundle.js'),'synthetic export content that is long enough to be detected as a rename\n'.repeat(5));
  const baseSha=commit('base');
  await mkdir(join(root,'src'));await rename(join(root,'site','bundle.js'),join(root,'src','bundle.js'));
  const headSha=commit('move out of site');
  const changed=changedPublicFiles({cwd:root,baseSha,headSha});
  assert.ok(changed.includes('site/bundle.js'),'the deleted source of the rename must be listed');
  assert.throws(()=>publicBuildMode({eventName:'pull_request',baseRef:'feat/newsroom-mvp',headRef:'feature',changedFiles:changed}),/Feature PRs must not change/);
});

test('the public host caches article lookups (hit and miss) but never a CMS failure; HTML stays no-store',async t=>{
  const {readFile}=await import('node:fs/promises');
  const {createPublicServer}=await import('../tools/serve-public.mjs');
  const dist=await mkdtemp(join(tmpdir(),'public-cache-'));
  await writeFile(join(dist,'index.html'),await readFile(new URL('../src/index.template.html',import.meta.url),'utf8'));
  let calls=0,fail=false;
  const article={id:1,status:'published',slug:'real-story',title:'Real story',excerpt:'x',corrections:[],content:null};
  const server=createPublicServer({dist,cmsUrl:'https://cms.example.test',siteUrl:'https://public.example.test',articlePathTemplate:'/{slug}/',fetchImpl:async url=>{
    const u=new URL(url);if(u.pathname==='/api/categories')return Response.json({docs:[]});
    calls++;if(fail)return new Response('no',{status:500});
    return Response.json({docs:u.searchParams.get('where[slug][equals]')==='real-story'?[article]:[]});
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dist,{recursive:true,force:true});});
  const origin='http://127.0.0.1:'+server.address().port;
  for(let i=0;i<3;i++){const r=await fetch(origin+'/real-story/');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');}
  assert.equal(calls,1);
  for(let i=0;i<3;i++)assert.equal((await fetch(origin+'/missing-story/')).status,404);
  assert.equal(calls,2);
  fail=true;
  for(let i=0;i<2;i++)assert.equal((await fetch(origin+'/other-story/')).status,503);
  assert.equal(calls,4);
});
