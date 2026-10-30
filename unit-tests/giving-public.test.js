// Giving on the public side: integer money parsing, checkout URL allow-list, return reference, and the /give/ host routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {majorToMinor,formatMinor,safeCheckoutUrl,returnReference} from '../src/features/giving/money.js';
import {givingEndpointFrom} from '../src/features/giving/endpoint.js';
import {publicPageRoute} from '../src/lib/public-page-routes.js';
import {RESERVED_ROOT_SLUGS} from '../src/lib/public-routes.js';
import {createPublicServer} from '../tools/serve-public.mjs';

const REF='CTG-0123456789abcdef0123456789abcdef';

test('typed amounts become exact integer minor units (no floats)',()=>{
  assert.equal(majorToMinor('5000'),500000);
  assert.equal(majorToMinor('5,000.5'),500050);
  assert.equal(majorToMinor(' 0.07 '),7);
  assert.equal(majorToMinor('1.10'),110); // 1.1 * 100 would be 110.00000000000001
  assert.equal(majorToMinor('19.99'),1999);
  for(const bad of ['','0','0.00','-5','5.001','1e3','abc','5.','.5','999999999999999'])assert.equal(majorToMinor(bad),null,bad);
  assert.equal(formatMinor(500050,'NGN'),'₦5,000.50');
  assert.equal(formatMinor(1000,'USD'),'$10');
});

test('only Paystack checkout (or the loopback test server) is ever opened',()=>{
  assert.equal(safeCheckoutUrl('https://checkout.paystack.com/abc'),'https://checkout.paystack.com/abc');
  assert.equal(safeCheckoutUrl('http://127.0.0.1:3291/checkout/x'),'http://127.0.0.1:3291/checkout/x');
  for(const bad of ['http://checkout.paystack.com/abc','https://checkout.paystack.com.evil.test/','https://evil.test/','javascript:alert(1)','https://u:p@checkout.paystack.com/x','//checkout.paystack.com/x',null])assert.equal(safeCheckoutUrl(bad),null,String(bad));
});

test('return reference: Paystack query, then this tab, and only the exact format',()=>{
  assert.equal(returnReference(`?trxref=${REF}&reference=${REF}`,null),REF);
  assert.equal(returnReference('?reference=nope',REF),REF);
  assert.equal(returnReference('?reference=<script>',null),null);
  assert.equal(returnReference('',null),null);
});

test('giving endpoint must be https (or loopback) without query or fragment',()=>{
  assert.equal(givingEndpointFrom('https://cms.example.test/api/public/giving/'),'https://cms.example.test/api/public/giving');
  assert.equal(givingEndpointFrom('http://localhost:3290/api/public/giving'),'http://localhost:3290/api/public/giving');
  for(const bad of [undefined,'','http://cms.example.test/api/public/giving','https://cms.example.test/api/public/giving?x=1','https://u:p@cms.example.test/'])assert.equal(givingEndpointFrom(bad),'',String(bad));
});

test('routes and reserved slugs',()=>{
  assert.deepEqual(publicPageRoute('/give/'),['give']);
  assert.deepEqual(publicPageRoute('/give/thanks/'),['give','thanks']);
  assert.equal(publicPageRoute('/give/other/'),null);
  for(const s of ['give','giving','donate'])assert.ok(RESERVED_ROOT_SLUGS.has(s),s);
});

async function host(t,settings) {
  const dist=await mkdtemp(join(tmpdir(),'public-give-'));
  await writeFile(join(dist,'index.html'),await readFile(new URL('../src/index.template.html',import.meta.url),'utf8'));
  const calls=[];
  const fetchImpl=async(url,init)=>{calls.push({url:String(url),init});if(settings instanceof Error)throw settings;return Response.json(settings);};
  const server=createPublicServer({dist,cmsUrl:'https://cms.example.test',siteUrl:'https://public.example.test',indexable:true,fetchImpl});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dist,{recursive:true,force:true});});
  return {origin:'http://127.0.0.1:'+server.address().port,calls};
}

test('/give/ is server-rendered when the CMS says giving is on, readable without JavaScript',async t=>{
  const {origin,calls}=await host(t,{enabled:true,provider:'paystack',currencies:[{currency:'NGN'}],causes:[],bankTransferNote:'Bank: Example Bank\nAccount: 0000000000 <b>x</b>'});
  const res=await fetch(origin+'/give/');
  const html=await res.text();
  assert.equal(res.status,200);
  assert.match(html,/<h1>Keep independent reporting free to read\.<\/h1>/);
  assert.match(html,/Account: 0000000000 &lt;b&gt;x&lt;\/b&gt;/,'CMS text is escaped');
  assert.match(html,/<noscript>/);
  assert.match(html,/<link rel="canonical" href="https:\/\/public\.example\.test\/give\/">/);
  assert.equal(res.headers.get('x-robots-tag'),'index,follow');
  assert.equal(calls[0].url,'https://cms.example.test/api/public/giving/settings');
  assert.equal(calls[0].init.redirect,'error');
  assert.equal((await fetch(origin+'/give',{redirect:'manual'})).status,308);
});

test('/give/ is a 404 when giving is off, a 503 when the CMS is down; /give/thanks/ always answers, never indexed or cached',async t=>{
  const off=await host(t,{enabled:false});
  assert.equal((await fetch(off.origin+'/give/')).status,404);
  const thanks=await fetch(off.origin+`/give/thanks/?trxref=${REF}&reference=${REF}`);
  const body=await thanks.text();
  assert.equal(thanks.status,200);
  assert.equal(thanks.headers.get('x-robots-tag'),'noindex,nofollow');
  assert.equal(thanks.headers.get('referrer-policy'),'no-referrer');
  assert.equal(thanks.headers.get('cache-control'),'no-store');
  assert.doesNotMatch(body,/rel="canonical"/);
  assert.doesNotMatch(body,new RegExp(REF),'the reference is not echoed into the HTML');
  const down=await host(t,new Error('down'));
  assert.equal((await fetch(down.origin+'/give/')).status,503);
});
