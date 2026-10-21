import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdvertisingDelivery } from '../src/lib/advertising-delivery.js';
test('Advertising unset makes no request; malformed response fails closed',async()=>{
  let calls=0;const fetch=async()=>{calls++;return new Response('{"campaigns":{}}');};await createAdvertisingDelivery({fetch}).load();assert.equal(calls,0);assert.deepEqual((await createAdvertisingDelivery({endpoint:'https://example.test/ads',fetch}).load()).campaigns,[]);
});
test('Advertising rejects insecure or credentialed remote endpoints before requests',async()=>{
  let calls=0;
  for(const endpoint of ['http://cms.example.test/api/public/advertising','https://user:pass@cms.example.test/ads','https://cms.example.test/ads?secret=x','https://cms.example.test/ads#fragment']) {
    await createAdvertisingDelivery({endpoint,fetch:async()=>{calls++;throw Error('Should not request');}}).load();
  }
  assert.equal(calls,0);
});
