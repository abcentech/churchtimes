import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdvertisingDelivery } from '../src/lib/advertising-delivery.js';
test('Advertising unset makes no request; malformed response fails closed',async()=>{
  let calls=0;const fetch=async()=>{calls++;return new Response('{"campaigns":{}}');};await createAdvertisingDelivery({fetch}).load();assert.equal(calls,0);assert.deepEqual((await createAdvertisingDelivery({endpoint:'https://example.test/ads',fetch}).load()).campaigns,[]);
});
