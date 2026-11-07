import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdvertisingDelivery } from '../src/lib/advertising-delivery.js';
test('Advertising C3 STUB server: browser GET cache, no conditional request, inactive AdSense and failure collapse',async()=>{
  let clock=0,calls=0;const service=createAdvertisingDelivery({endpoint:'https://cms.example.test/api/public/advertising',now:()=>clock,fetch:async(url,options)=>{calls++;assert.equal(options.headers,undefined);assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');return new Response(JSON.stringify({campaigns:[],adsense:{enabled:true,reviewed:true}}),{headers:{etag:'"stub"'}});}});
  assert.equal((await service.load()).adsense.enabled,false);await service.load();assert.equal(calls,1);clock=61000;await service.load();assert.equal(calls,2);
  const broken=createAdvertisingDelivery({endpoint:'https://cms.example.test/api/public/advertising',fetch:async()=>{throw Error('STUB failure');}});assert.deepEqual((await broken.load()).campaigns,[]);
});

test('C3 synthetic STUB freshness stops at the next start/end or server cache age, capped at60s',async()=>{
  for(const [campaigns,header,boundary] of [
    [[{startsAt:new Date(5000).toISOString(),endsAt:new Date(12000).toISOString()}],null,5000],
    [[{startsAt:new Date(0).toISOString(),endsAt:new Date(9000).toISOString()}],null,9000],
    [[], 'public, max-age=3',3000],
    [[], 'public, max-age=600',60000],
  ]) {
    let clock=1000,calls=0;
    const service=createAdvertisingDelivery({endpoint:'https://cms.example.test/api/public/advertising',now:()=>clock,fetch:async()=>{calls++;return Response.json({campaigns},{headers:header?{'Cache-Control':header}:{}});}});
    await Promise.all([service.load(),service.load()]);assert.equal(calls,1);
    const expires=header?1000+boundary:boundary;
    clock=expires-1;await service.load();assert.equal(calls,1);
    clock=expires;await service.load();assert.equal(calls,2);
  }
});

test('C3 synthetic STUB failures and unsupported 304 collapse without trusting old campaigns',async()=>{
  for(const status of [304,403,503]) {
    const service=createAdvertisingDelivery({endpoint:'https://cms.example.test/api/public/advertising',fetch:async()=>new Response(null,{status})});
    assert.deepEqual((await service.load()).campaigns,[]);
  }
});
