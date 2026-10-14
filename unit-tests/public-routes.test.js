import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicRoutes } from '../src/lib/public-routes.js';

test('clean article routes and canonical URLs retain the configured hosting prefix',()=>{
  const routes=createPublicRoutes({siteUrl:'https://staging.example.test/churchtimes/'});
  assert.equal(routes.path('report','a-report'),'/churchtimes/reports/a-report/');
  assert.equal(routes.canonical('report','a-report'),'https://staging.example.test/churchtimes/reports/a-report/');
  assert.deepEqual(routes.parse({pathname:'/churchtimes/reports/a-report/'}),['report','a-report']);
  assert.deepEqual(routes.parse({pathname:'/churchtimes/sections/news/'}),['section','news']);
  assert.deepEqual(routes.parse({pathname:'/churchtimes/search/',search:'?q=faith%20%26%20life'}),['search','faith & life']);
  assert.equal(routes.parse({pathname:'/other/'}),null);
  assert.deepEqual(routes.parse({pathname:'/churchtimes/reports/%XX/'}),['404','']);
});
test('public site configuration rejects insecure hosts, credentials and hash canonical URLs',()=>{
  for(const siteUrl of ['http://remote.test/','https://user:password@example.test/','https://example.test/#report/a','https://example.test/?q=x','javascript:alert(1)'])assert.throws(()=>createPublicRoutes({siteUrl}));
});
