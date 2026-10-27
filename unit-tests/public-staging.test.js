import test from 'node:test';
import assert from 'node:assert/strict';
import {submissionEndpoint,sendPublicSubmission} from '../src/lib/public-submissions.js';
import {fetchPublishedPage,fetchPublicCategory} from '../src/lib/published-articles.js';
import {reportPath,reportSlug,articleCanonical,safeJSON} from '../src/lib/public-routes.js';
import {createPublicServer} from '../tools/serve-public.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const article={id:1,status:'published',slug:'cms-report',title:'A published report',excerpt:'Public excerpt',bylineName:'Public writer',content:'Public body',corrections:[]};
const values={name:'A reader',email:'reader@example.test',phone:'+234 803 123 4567',title:'A local story',message:'A detailed story with enough public context.',category:'News',consent:true};
test('reserved localhost subdomains support staging without allowing HTTP on remote hosts',()=>{
 for(const host of ['localhost','127.0.0.1','[::1]','cms.churchtimes.localhost'])assert.ok(submissionEndpoint({cmsUrl:`http://${host}:3400`}));
 for(const host of ['localhost.evil.test','evil-localhost','cms.example.test'])assert.equal(submissionEndpoint({cmsUrl:`http://${host}:3400`}), '');
});
test('numeric relationship filters and published-only search use real Payload query names',async()=>{
 let calls=0;
 const fetchImpl=async(url,options)=>{calls++;const u=new URL(url);assert.equal(options.credentials,'omit');assert.equal(u.searchParams.get('where[status][equals]'),'published');assert.equal(u.searchParams.get('where[and][0][or][0][category][equals]'),'12');assert.equal(u.searchParams.get('where[and][0][or][1][categories][equals]'),'12');assert.equal(u.searchParams.get('where[or][2][bylineName][like]'),'Faith & service');return Response.json({docs:[article]});};
 await fetchPublishedPage({baseUrl:'https://cms.example.test',categoryId:12,query:' Faith & service ',fetchImpl});
 await assert.rejects(fetchPublishedPage({baseUrl:'https://cms.example.test',categoryId:'news',fetchImpl}),e=>e.type==='configuration');assert.equal(calls,1);
 const cat=await fetchPublicCategory({baseUrl:'https://cms.example.test',slug:'news',fetchImpl:async url=>{assert.equal(new URL(url).pathname,'/api/categories');return Response.json({docs:[{id:12,slug:'news',title:'News'}]});}});assert.equal(cat.id,'12');
});
test('canonical paths reject unsafe slugs and serialize structured data as inert JSON',()=>{
 assert.equal(reportPath('cms-report','/churchtimes/'),'/churchtimes/reports/cms-report/');assert.equal(reportSlug('/reports/cms-report/'),'cms-report');assert.equal(reportSlug('/reports/%2fadmin/'),null);
 assert.equal(articleCanonical('cms-report',{siteUrl:'https://public.example.test',basePath:'/churchtimes/'}),'https://public.example.test/churchtimes/reports/cms-report/');
 assert.equal(articleCanonical('cms-report',{siteUrl:'https://user:secret@public.example.test'}),'');assert.ok(!safeJSON({text:'</script><script>alert(1)</script>'}).includes('<'));
});
test('public SSR serves real article HTML/metadata, anonymous requests and genuine HTTP failure statuses',async()=>{
 const dist=await mkdtemp(join(tmpdir(),'public-ssr-test-'));
 await writeFile(join(dist,'index.html'),'<html><head><title>Public site</title><meta name="description" content="Default"><meta property="og:title" content="Default"><meta property="og:description" content="Default"><meta property="og:type" content="website"></head><body><div id="app"></div></body></html>');
 const server=createPublicServer({articlePathTemplate:'/reports/{slug}/',dist,basePath:'/journal/',cmsUrl:'https://cms.example.test',siteUrl:'https://public.example.test',indexable:true,fetchImpl:async(url,options)=>{
   assert.equal(options.credentials,'omit');assert.equal(options.headers.Cookie,undefined);
   const slug=new URL(url).searchParams.get('where[slug][equals]');if(slug==='failed')return new Response('',{status:403});return Response.json({docs:slug===article.slug?[article]:[]});
 }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try {
  const good=await fetch(origin+'/journal/reports/cms-report/',{headers:{Cookie:'staff-cookie=must-not-forward'}});const html=await good.text();assert.equal(good.status,200);assert.match(html,/<h1>A published report<\/h1>/);assert.match(html,/Public body/);assert.match(html,/rel="canonical" href="https:\/\/public.example.test\/journal\/reports\/cms-report\/"/);assert.match(html,/application\/ld\+json/);
  assert.equal((await fetch(origin+'/journal/reports/missing/')).status,404);const failed=await fetch(origin+'/journal/reports/failed/');assert.equal(failed.status,503);assert.equal(failed.headers.get('x-robots-tag'),'noindex,nofollow');assert.equal((await fetch(origin+'/journal/reports/cms-report',{redirect:'manual'})).status,308);assert.equal((await fetch(origin+'/journal/reports/cms-report/',{method:'POST'})).status,405);
 } finally {await new Promise(resolve=>server.close(resolve));await rm(dist,{recursive:true,force:true});}
});
test('late response-body timeout and inherited error fields never produce success or unsafe input mapping',async()=>{
 await assert.rejects(sendPublicSubmission({endpoint:'http://cms.churchtimes.localhost:3400/api/public/submissions',values,token:'valid',timeoutMs:5,fetchImpl:async(_url,{signal})=>({status:201,ok:true,json:()=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))))})}),e=>e.type==='timeout');
 await assert.rejects(sendPublicSubmission({endpoint:'https://cms.example.test',values,token:'valid',fetchImpl:async()=>Response.json({errors:[{field:'__proto__'},{field:'constructor'},{field:'body',message:'private'}]},{status:400})}),e=>Object.keys(e.fields).join()==='message');
});
