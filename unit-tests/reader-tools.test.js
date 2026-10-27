import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyShareLink } from '../src/lib/reader-tools.js';
test('Copy-link fallback selects readonly link and provides instructions',async()=>{
  let selected=false;const input={value:'https://example.test/story/',focus(){},select(){selected=true;}};const status={};assert.equal(await copyShareLink(input,status,{writeText:async()=>{throw Error('denied');}}),false);assert.equal(selected,true);assert.match(status.textContent,/selected/);
});
