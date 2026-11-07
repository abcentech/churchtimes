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
test('GA4 automatic event configuration strips query/hash and disables automatic page views',()=>{
  const win={location:{origin:'https://example.test',pathname:'/newsletter/confirm',search:'?token=STUB',hash:'#private'}};
  const doc={head:{append(){}},createElement:()=>({addEventListener(){}})};
  createAnalytics({env:{VITE_PUBLIC_INDEXABLE:'true',VITE_PUBLIC_GA4_ID:'G-STUB0000'},window:win,document:doc}).update(true);
  const config=Array.from(win.dataLayer.find(item=>item[0]==='config'))[2];
  assert.equal(config.page_location,'https://example.test/newsletter/confirm');assert.equal(config.page_referrer,'');assert.equal(config.send_page_view,false);
});
import { reportableRoute, reportableTitle } from '../src/lib/reader-analytics.js';
test('reported routes keep the route and a plain slug but never search terms, tokens or unknown fragments',()=>{
  assert.equal(reportableRoute({pathname:'/',hash:''}),'/');
  assert.equal(reportableRoute({pathname:'/',hash:'#search/secret%20term'}),'/#search');
  assert.equal(reportableRoute({pathname:'/',hash:'#report/faith-in-public-life'}),'/#report/faith-in-public-life');
  assert.equal(reportableRoute({pathname:'/',hash:'#section/news'}),'/#section/news');
  assert.equal(reportableRoute({pathname:'/',hash:'#story/Some%20Token%2Fx'}),'/#story');
  assert.equal(reportableRoute({pathname:'/newsletter/confirm',hash:'#token=abc123'}),'/newsletter/confirm');
  assert.equal(reportableRoute({pathname:'/',hash:'#%E0%A4%A'}),'/');
  assert.equal(reportableTitle({pathname:'/',hash:'#search/x'},'Results for “x” — Church Times Nigeria'),'Search — Church Times Nigeria');
  assert.equal(reportableTitle({pathname:'/',hash:'#latest'},'Latest — Church Times Nigeria'),'Latest — Church Times Nigeria');
});
test('page_view uses the sanitized route and a fixed search title, and waits for the host when onReady is given',()=>{
  const win={location:{origin:'https://example.test',pathname:'/',search:'',hash:'#search/private%20query'}};let load;const scripts=[];
  const doc={title:'Results for “private query” — Church Times Nigeria',head:{append:s=>scripts.push(s)},createElement:()=>({addEventListener:(_n,cb)=>{load=cb;}})};
  let readyCalls=0;const analytics=createAnalytics({env:{VITE_PUBLIC_INDEXABLE:'true',VITE_PUBLIC_GA4_ID:'G-STUB0000'},window:win,document:doc,onReady:()=>readyCalls++});
  analytics.update(true);load();
  assert.equal(readyCalls,1);
  assert.equal(win.dataLayer.filter(item=>item[0]==='event').length,0,'no page_view until the host reports');
  analytics.page();
  const event=Array.from(win.dataLayer.find(item=>item[0]==='event'));
  assert.equal(event[2].page_location,'https://example.test/#search');
  assert.equal(event[2].page_title,'Search — Church Times Nigeria');
  assert.ok(!JSON.stringify(win.dataLayer.map(item=>Array.from(item))).includes('private'));
});
