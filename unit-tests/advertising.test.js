import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdvertisingDelivery } from '../src/lib/advertising-delivery.js';
test('Advertising C3 STUB server: caching, conditional ETag, inactive AdSense and failure collapse',async()=>{
  let clock=0,calls=0,conditional;const service=createAdvertisingDelivery({endpoint:'https://cms.example.test/api/public/advertising',now:()=>clock,fetch:async(url,options)=>{calls++;conditional=options.headers['If-None-Match'];assert.equal(options.credentials,'omit');return calls===1?new Response(JSON.stringify({campaigns:[],adsense:{enabled:true,reviewed:true}}),{headers:{etag:'"stub"'}}):new Response(null,{status:304});}});
  assert.equal((await service.load()).adsense.enabled,false);await service.load();assert.equal(calls,1);clock=61000;await service.load();assert.equal(conditional,'"stub"');
  const broken=createAdvertisingDelivery({endpoint:'https://cms.example.test/api/public/advertising',fetch:async()=>{throw Error('STUB failure');}});assert.deepEqual((await broken.load()).campaigns,[]);
});
