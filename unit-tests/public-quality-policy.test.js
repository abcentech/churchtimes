import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// This policy is deliberately independent of the configurable validator and its
// report stubs. Changing a threshold requires an explicit policy/doc review.
test('numeric quality policy pins every documented floor and ceiling',async()=>{
 const budgets=JSON.parse(await readFile(new URL('../tools/public-quality-budgets.json',import.meta.url),'utf8'));
 assert.deepEqual(budgets,{
  pages:['home','latest','article','live'],
  minPerformance:80,
  minAccessibility:100,
  minBestPractices:95,
  maxLcpMs:6000,
  maxCls:0.1,
  maxInitialJsGzipBytes:40*1024,
  maxInitialCssGzipBytes:12*1024,
  maxFontBytes:192*1024,
 });
});
test('both public production workflow events include Vite build configuration',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/public-quality.yml',import.meta.url),'utf8');
 for(const event of ['push','pull_request']) {
  const block=workflow.match(new RegExp(`^  ${event}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|^permissions:|$(?![\\s\\S]))`,'m'))?.[1];
  assert.ok(block,`${event} event exists`);
  assert.match(block,/^    paths:\n/m,`${event} has a paths filter`);
  assert.match(block,/^      - 'vite\.config\.js'$/m,`${event} runs the quality gate for Vite configuration`);
 }
});
