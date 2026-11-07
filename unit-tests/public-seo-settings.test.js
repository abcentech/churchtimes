import test from 'node:test';
import assert from 'node:assert/strict';
import {publicSEOSettings} from '../tools/public-seo-settings.mjs';
import {createPublicServer} from '../tools/serve-public.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('ads.txt is absent until an owner-supplied line exists; verification is opt-in',()=>{
 const settings=publicSEOSettings();let response;
 assert.equal(settings.head,'');assert.equal(settings.route(new URL('https://public.example.test/ads.txt'),(...args)=>response=args),true);
 assert.equal(response[0],404);assert.equal(response[2],'');assert.equal(settings.route(new URL('https://public.example.test/other'),()=>assert.fail()),false);
 const supplied=publicSEOSettings({adsTxtLine:'example.test, synthetic-publisher, DIRECT',searchVerification:'synthetic-owner-verification'});
 supplied.route(new URL('https://public.example.test/ads.txt'),(...args)=>response=args);assert.equal(response[0],200);assert.equal(response[2],'example.test, synthetic-publisher, DIRECT\n');assert.match(supplied.head,/google-site-verification/);assert.doesNotMatch(supplied.head,/<script/);
});
test('publisher configuration rejects multiline records, markup and malformed tokens',()=>{
 for(const adsTxtLine of ['google.com, invented-id, DIRECT\n# another line','<script>','example.test, id, UNKNOWN','example.test, id, DIRECT\nexample.test, other, DIRECT'])assert.throws(()=>publicSEOSettings({adsTxtLine}),/PUBLIC_ADS_TXT_LINE/);
 for(const searchVerification of ['<script>','token" onload="x','token value','a'.repeat(201)])assert.throws(()=>publicSEOSettings({searchVerification}),/PUBLIC_SEARCH_CONSOLE_VERIFICATION/);
});
test('public host exposes only supplied records/tokens and preserves staging noindex on every page',async t=>{
 const dist=await mkdtemp(join(tmpdir(),'public-owner-seo-'));
 await writeFile(join(dist,'index.html'),'<html><head></head><body><div id="app"></div></body></html>');
 const server=createPublicServer({dist,siteUrl:'https://public.example.test',basePath:'/journal/',adsTxtLine:'example.test, synthetic-publisher, DIRECT',searchVerification:'synthetic-owner-verification'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dist,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+server.address().port;
 const ad=await fetch(origin+'/ads.txt');assert.equal(ad.status,200);assert.equal(await ad.text(),'example.test, synthetic-publisher, DIRECT\n');
 for(const path of ['','about/','contact/','advertise/']) {
  const response=await fetch(origin+'/journal/'+path);assert.equal(response.status,200);assert.equal(response.headers.get('x-robots-tag'),'noindex,nofollow');const html=await response.text();assert.match(html,/name="google-site-verification" content="synthetic-owner-verification"/);assert.doesNotMatch(html,/adsbygoogle|googletagmanager/);
 }
});

// Synthetic owner records and a local HTTP host; no publisher service is contacted.
test('publisher records permit horizontal spaces/tabs and reject all vertical separators',()=>{
 for(const separator of [' ', '\t', ' \t ']) {
  const record=`example.test,${separator}synthetic-publisher,${separator}DIRECT,${separator}abcdef`;
  const settings=publicSEOSettings({adsTxtLine:` \t${record}\t `});let response;
  settings.route(new URL('https://public.example.test/ads.txt'),(...args)=>response=args);
  assert.equal(response[2],record+'\n');
 }
 for(const separator of ['\v','\f','\u0085','\u00a0','\u2028','\u2029','\r','\n']) {
  for(const record of [
   `example.test,${separator}synthetic-publisher, DIRECT`,
   `example.test, synthetic-publisher,${separator}DIRECT`,
   `example.test, synthetic-publisher, DIRECT,${separator}abcdef`,
   `${separator}example.test, synthetic-publisher, DIRECT`,
   `example.test, synthetic-publisher, DIRECT${separator}`,
  ])assert.throws(()=>publicSEOSettings({adsTxtLine:record}),/PUBLIC_ADS_TXT_LINE/);
 }
});
test('ads.txt GET/HEAD preserve security/cache headers; POST is rejected without disclosing the record',async t=>{
 const record='example.test, synthetic-publisher, DIRECT';
 const server=createPublicServer({adsTxtLine:record});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url='http://127.0.0.1:'+server.address().port+'/ads.txt';
 for(const method of ['GET','HEAD']) {
  const response=await fetch(url,{method});assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'text/plain; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('cache-control'),'public, max-age=60');
  assert.equal(response.headers.get('content-length'),String(Buffer.byteLength(record+'\n')));
  assert.equal(response.headers.get('x-robots-tag'),'noindex');
  assert.equal(await response.text(),method==='HEAD'?'':record+'\n');
 }
 const response=await fetch(url,{method:'POST',body:'synthetic request'});
 assert.equal(response.status,405);assert.equal(response.headers.get('allow'),'GET, HEAD');
 assert.equal(response.headers.get('content-type'),'text/plain');
 assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(await response.text(),'Method not allowed');
});
