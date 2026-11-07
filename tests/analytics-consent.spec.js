import { test, expect } from '@playwright/test';
test('GA4 configured synthetic ID STUB transport requests once only after consent',async({page})=>{
  let requests=0;
  await page.route('https://www.googletagmanager.com/**',route=>{requests++;return route.fulfill({contentType:'text/javascript',body:'/* STUB GA4 transport: no measurement or external connection. */'});});
  await page.goto('/');
  await page.evaluate(async()=>{
    const {createAnalytics}=await import('/src/lib/reader-analytics.js');
    window.stubAnalytics=createAnalytics({env:{VITE_PUBLIC_INDEXABLE:'true',VITE_PUBLIC_GA4_ID:'G-STUB0000'}});
    window.stubAnalytics.update(false);
  });
  expect(requests).toBe(0);
  await page.evaluate(()=>window.stubAnalytics.update(true));await expect.poll(()=>requests).toBe(1);
  await page.evaluate(()=>window.stubAnalytics.update(true));expect(requests).toBe(1);
  await page.evaluate(()=>window.stubAnalytics.update(false));
  expect(await page.evaluate(()=>window['ga-disable-G-STUB0000'])).toBe(true);
});
test('No optional tracking with unset config even after privacy opt in',async({page})=>{
  const requests=[];page.on('request',r=>{if(/googletagmanager|google-analytics|clarity\.ms|googlesyndication/.test(r.url()))requests.push(r.url());});
  await page.goto('/');await page.getByRole('button',{name:'Privacy & reading list'}).click();await expect(page.getByLabel('Allow configured audience analytics')).not.toBeChecked();await page.getByLabel('Allow configured audience analytics').check();expect(requests).toEqual([]);
});
