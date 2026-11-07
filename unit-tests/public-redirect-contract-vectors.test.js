// Runs the CMS lane's shared C7.1 test vectors (apps/cms/tests/fixtures/redirect-normalisation.json) against the host's copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {normalizePath,normalizeRequestPath} from '../tools/public-redirect-paths.mjs';
import {legacyHostRedirector} from '../tools/public-redirects.mjs';
import {reportSlug} from '../src/lib/public-routes.js';
import {createPublicServer} from '../tools/serve-public.mjs';
const vectors=JSON.parse(readFileSync(new URL('../apps/cms/tests/fixtures/redirect-normalisation.json',import.meta.url),'utf8'));
test('CMS normalize vectors give the same canonical key',()=>{
 for(const {input,path} of vectors.normalize){assert.deepEqual(normalizePath(input),{ok:true,path},String(input));assert.deepEqual(normalizePath(path),{ok:true,path},'idempotent '+path);}
});
test('CMS reject vectors are rejected',()=>{
 for(const {input,why} of vectors.reject)assert.equal(normalizePath(input).ok,false,why+': '+JSON.stringify(input));
});
test('CMS request vectors normalise a raw request target, ignoring query and fragment',()=>{
 for(const {input,path} of vectors.request)assert.equal(normalizeRequestPath(input),path,String(input));
});
test('CMS root article vectors: canonical key and slug under /{slug}/',()=>{
 for(const {request,path,slug} of vectors.rootArticlePath.vectors) {
  assert.equal(normalizeRequestPath(request),path,request);
  assert.equal(reportSlug(path,'/','/{slug}/'),slug,request);
 }
});
const get=(port,host,path)=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path,headers:{Host:host}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,location:res.headers.location}));});req.on('error',reject);req.end();});
test('legacy hosts redirect to the primary host with the same path and query, never to the request Host',()=>{
 const redirect=legacyHostRedirector({siteUrl:'https://churchtimesnigeria.net'});
 for(const host of ['churchtimesnigeria.org','churchtimesnigeria.com','www.churchtimesnigeria.org','www.churchtimesnigeria.com','www.churchtimesnigeria.net','CHURCHTIMESNIGERIA.ORG:443'])
  assert.equal(redirect(host,'/some-article/?a=1'),'https://churchtimesnigeria.net/some-article/?a=1',host);
 for(const host of ['churchtimesnigeria.net','evil.example','churchtimesnigeria.org.evil.example','localhost:8080',undefined])assert.equal(redirect(host,'/x/'),'',String(host));
 assert.equal(redirect('churchtimesnigeria.org','//evil.example/'),'');
 assert.equal(legacyHostRedirector({siteUrl:'http://churchtimesnigeria.net'})('churchtimesnigeria.org','/'),'');
 assert.equal(legacyHostRedirector({})('churchtimesnigeria.org','/'),'');
 assert.equal(legacyHostRedirector({siteUrl:'https://churchtimesnigeria.net',legacySiteHosts:'old.example'})('churchtimesnigeria.org','/'),'');
 assert.equal(legacyHostRedirector({siteUrl:'https://churchtimesnigeria.net',legacySiteHosts:'old.example'})('old.example','/a/'),'https://churchtimesnigeria.net/a/');
 assert.throws(()=>legacyHostRedirector({siteUrl:'https://churchtimesnigeria.net',legacySiteHosts:'a/b'}));
});
test('public host answers legacy hosts with one 301 before exact rules, and leaves the primary host alone',async t=>{
 const dist=await mkdtemp(join(tmpdir(),'public-legacy-hosts-'));await writeFile(join(dist,'index.html'),await readFile(new URL('../src/index.template.html',import.meta.url),'utf8'));
 const file=join(dist,'r.json');await writeFile(file,JSON.stringify({version:'sha256:s',generatedAt:'2026-10-16T00:00:00Z',count:1,rules:[{from:'/old-slug/',to:'/new-slug/',status:301,source:'manual'}]}));
 const server=createPublicServer({dist,siteUrl:'https://churchtimesnigeria.net',redirectsFile:file,cmsUrl:'https://cms.example.test',fetchImpl:async()=>Response.json({docs:[]})});await server.publicReady;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dist,{recursive:true,force:true});});
 const port=server.address().port;
 assert.deepEqual(await get(port,'churchtimesnigeria.org','/old-slug/?a=1'),{status:301,location:'https://churchtimesnigeria.net/old-slug/?a=1'});
 assert.deepEqual(await get(port,'www.churchtimesnigeria.com','/x/'),{status:301,location:'https://churchtimesnigeria.net/x/'});
 assert.deepEqual(await get(port,'churchtimesnigeria.net','/old-slug'),{status:301,location:'/new-slug/'});
});
