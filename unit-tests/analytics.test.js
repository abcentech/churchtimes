import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalytics, analyticsConfig } from '../src/lib/reader-analytics.js';
test('GA4 synthetic ID STUB transport: staging, unconfigured and unconsented never load',()=>{
  assert.equal(analyticsConfig({VITE_PUBLIC_GA4_ID:'G-STUB0000'}).enabled,false);
  const scripts=[];const win={location:{origin:'https://example.test',pathname:'/reports/story/'}};const doc={head:{append:s=>scripts.push(s)},createElement:()=>({addEventListener(){}})};
  const inactive=createAnalytics({env:{VITE_PUBLIC_INDEXABLE:'true'},window:win,document:doc});inactive.update(true);assert.equal(scripts.length,0);
  const active=createAnalytics({env:{VITE_PUBLIC_INDEXABLE:'true',VITE_PUBLIC_GA4_ID:'G-STUB0000'},window:win,document:doc});
  active.update(false);assert.equal(scripts.length,0);active.update(true);active.update(true);assert.equal(scripts.length,1);active.update(false);assert.equal(win['ga-disable-G-STUB0000'],true);
});
