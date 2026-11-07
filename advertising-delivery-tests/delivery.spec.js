import {test,expect} from '@playwright/test';
import {configureAds,fixtureConfig} from '../advertising-tests/fixtures.js';
test('C3 synthetic STUB endpoint renders direct campaigns once and caches route changes',async({page})=>{
  // Keep the billboard below the first viewport: unknown visible inventory is
  // deliberately skipped rather than shifting already-painted editorial text.
  await page.setViewportSize({...page.viewportSize(),height:600});
  await page.clock.install();
  await page.addInitScript(()=>{window.stubCLS=0;new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!entry.hadRecentInput)window.stubCLS+=entry.value;}).observe({type:'layout-shift',buffered:true});});
  const headers=[];let calls=0;await configureAds(page);await page.route('**/api/public/advertising',route=>{calls++;headers.push(route.request().headers());return route.fulfill({contentType:'application/json',headers:{ETag:'"synthetic-stub"'},body:JSON.stringify(fixtureConfig)});});
  await page.goto('/');await expect(page.locator('[data-ad-placement="homepage-billboard"]')).toBeVisible();
  await page.getByRole('link',{name:'Advertise',exact:true}).first().click();await expect(page.getByRole('heading',{name:'A considered audience. A meaningful conversation.'})).toBeVisible();expect(calls).toBe(1);
  await page.clock.fastForward(61000);await page.getByRole('link',{name:'Church Times Nigeria home',exact:true}).first().click();await expect(page.locator('[data-ad-placement="homepage-billboard"]')).toBeVisible();expect(calls).toBe(2);expect(headers.every(header=>!header['if-none-match'])).toBe(true);
  expect(await page.evaluate(()=>window.stubCLS)).toBeLessThanOrEqual(.1);
  expect(await page.locator('script[src*="googlesyndication"]').count()).toBe(0);
});
test('C3 synthetic STUB malformed response collapses all slots without console or page errors',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});await page.route('**/api/public/advertising',route=>route.fulfill({contentType:'application/json',body:'{"campaigns":{}}'}));
  await page.goto('/');await expect(page.locator('h1')).toBeVisible();await expect(page.locator('[data-ad-placement],[data-pending-ad-placement]')).toHaveCount(0);expect(errors).toEqual([]);
});

test('delayed C3 synthetic STUB never blocks content, resets focus or fills a stale route',async({page})=>{
  let release,requested;const waiting=new Promise(resolve=>release=resolve), started=new Promise(resolve=>requested=resolve);
  await configureAds(page);await page.route('**/api/public/advertising',async route=>{requested();await waiting;await route.fulfill({contentType:'application/json',body:JSON.stringify(fixtureConfig)});});
  await page.goto('/',{waitUntil:'domcontentloaded'});await started;
  await expect(page.getByRole('heading',{level:1})).toBeVisible();
  await page.getByRole('link',{name:'Advertise',exact:true}).first().click();
  await expect(page.getByRole('heading',{name:'A considered audience. A meaningful conversation.'})).toBeVisible();
  await expect(page.locator('#main')).toBeFocused();
  release();await expect(page.locator('[data-ad-placement],[data-pending-ad-placement]')).toHaveCount(0);
  await expect(page.locator('#main')).toBeFocused();
});

test('delayed C3 synthetic STUB skips visible markers without a gap or layout shift',async({page})=>{
  let release,requested;const waiting=new Promise(resolve=>release=resolve), started=new Promise(resolve=>requested=resolve);
  await configureAds(page);await page.route('**/api/public/advertising',async route=>{requested();await waiting;await route.fulfill({contentType:'application/json',body:JSON.stringify(fixtureConfig)});});
  await page.goto('/',{waitUntil:'domcontentloaded'});await started;
  const marker=page.locator('[data-pending-ad-placement="homepage-billboard"]');
  await expect(marker).toHaveCount(1);
  await marker.evaluate(element=>window.scrollTo(0,scrollY+element.getBoundingClientRect().top-150));
  const before=await page.locator('#latest').boundingBox();
  await page.evaluate(()=>{window.stubCLS=0;window.stubObserver=new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!entry.hadRecentInput)window.stubCLS+=entry.value;});window.stubObserver.observe({type:'layout-shift'});});
  release();await expect(page.locator('[data-pending-ad-placement]')).toHaveCount(0);
  await expect(page.locator('[data-ad-placement="homepage-billboard"]')).toHaveCount(0);
  const after=await page.locator('#latest').boundingBox();expect(Math.abs(before.y-after.y)).toBeLessThan(1);
  expect(await page.evaluate(()=>window.stubCLS)).toBeLessThanOrEqual(.1);
});

test('C3 synthetic STUB cache expires at campaign end and refreshes with a plain GET',async({page})=>{
  await page.setViewportSize({...page.viewportSize(),height:600});
  const start=Date.parse('2026-10-16T12:00:00Z');await page.clock.install({time:new Date(start)});
  const config=structuredClone(fixtureConfig);for(const campaign of config.campaigns)campaign.endsAt=new Date(start+5000).toISOString();
  let calls=0;await configureAds(page);await page.route('**/api/public/advertising',route=>{calls++;expect(route.request().method()).toBe('GET');expect(route.request().headers()['if-none-match']).toBeUndefined();return route.fulfill({contentType:'application/json',headers:{'Cache-Control':'public, max-age=60'},body:JSON.stringify(calls===1?config:{campaigns:[]})});});
  await page.goto('/');await expect(page.locator('[data-ad-placement="homepage-billboard"]')).toBeVisible();
  await page.clock.fastForward(4000);await page.getByRole('link',{name:'Advertise',exact:true}).first().click();expect(calls).toBe(1);
  await page.clock.fastForward(1001);await page.getByRole('link',{name:'Church Times Nigeria home',exact:true}).first().click();
  await expect.poll(()=>calls).toBe(2);await expect(page.locator('[data-ad-placement],[data-pending-ad-placement]')).toHaveCount(0);
});
