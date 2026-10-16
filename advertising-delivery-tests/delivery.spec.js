import {test,expect} from '@playwright/test';
import {configureAds,fixtureConfig} from '../advertising-tests/fixtures.js';
test('C3 synthetic STUB endpoint renders direct campaigns once and caches route changes',async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>{window.stubCLS=0;new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!entry.hadRecentInput)window.stubCLS+=entry.value;}).observe({type:'layout-shift',buffered:true});});
  let calls=0,conditional;await configureAds(page);await page.route('**/api/public/advertising',route=>{calls++;conditional=route.request().headers()['if-none-match'];if(calls>1)return route.fulfill({status:304,headers:{ETag:'"synthetic-stub"'}});return route.fulfill({contentType:'application/json',headers:{ETag:'"synthetic-stub"'},body:JSON.stringify(fixtureConfig)});});
  await page.goto('/');await expect(page.locator('[data-ad-placement="homepage-billboard"]')).toBeVisible();
  await page.getByRole('link',{name:'Advertise',exact:true}).first().click();await expect(page.getByRole('heading',{name:'A considered audience. A meaningful conversation.'})).toBeVisible();expect(calls).toBe(1);
  await page.clock.fastForward(61000);await page.getByRole('link',{name:'Church Times Nigeria home',exact:true}).first().click();await expect(page.locator('[data-ad-placement="homepage-billboard"]')).toBeVisible();expect(calls).toBe(2);expect(conditional).toBe('"synthetic-stub"');
  expect(await page.evaluate(()=>window.stubCLS)).toBeLessThanOrEqual(.1);
  expect(await page.locator('script[src*="googlesyndication"]').count()).toBe(0);
});
test('C3 synthetic STUB failure collapses all slots silently',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/api/public/advertising',route=>route.fulfill({status:503,body:'STUB unavailable'}));
  await page.goto('/');await expect(page.locator('h1')).toBeVisible();await expect(page.locator('[data-ad-placement]')).toHaveCount(0);expect(errors).toEqual([]);
});
