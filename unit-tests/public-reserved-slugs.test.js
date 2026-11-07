import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {RESERVED_ROOT_SLUGS,reportPath} from '../src/lib/public-routes.js';
// The CMS list is TypeScript; read the Set literal from source so the two lists cannot drift.
test('public reserved root slugs are identical to the CMS list',async()=>{
  const source=await readFile(new URL('../apps/cms/src/lib/reservedSlugs.ts',import.meta.url),'utf8');
  const body=source.match(/RESERVED_ROOT_SLUGS[^=]*=\s*new Set\(\[([\s\S]*?)\]\);/)[1];
  const cms=[...body.replace(/\/\/.*$/gm,'').matchAll(/"([^"]+)"/g)].map(m=>m[1]);
  assert.ok(cms.length>40);
  assert.equal(new Set(cms).size,cms.length,'CMS list has duplicates');
  assert.deepEqual([...RESERVED_ROOT_SLUGS].sort(),[...cms].sort());
});
test('a reserved slug yields no article path under /{slug}/ but is fine under /reports/{slug}/',()=>{
  for(const slug of ['latest','site','index','saved'])assert.equal(reportPath(slug,'/','/{slug}/'),'');
  assert.equal(reportPath('latest','/','/reports/{slug}/'),'/reports/latest/');
});
