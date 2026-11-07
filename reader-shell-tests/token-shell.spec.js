import {test,expect} from '@playwright/test';
for(const prefix of ['', '/preview'])for(const action of ['confirm','unsubscribe']) {
 test(`Actual exported ${prefix||'root'} ${action} shell strips its STUB token and waits for a button POST`,async({page})=>{
  const requests=[],external=[];let payload;
  page.on('request',request=>{const url=new URL(request.url());if(url.origin!=='http://127.0.0.1:6198')external.push(url.origin);});
  await page.route(`**/api/public/newsletter/${action}`,async route=>{requests.push(route.request().method());payload=route.request().postDataJSON();await route.fulfill({status:200,json:{ok:true}});});
  const token='SYNTHETIC-STUB-TOKEN';await page.goto(`${prefix}/newsletter/${action}?token=${token}#private`);
  await expect(page).toHaveURL(new RegExp(`${prefix}/newsletter/${action}$`));
  await expect(page.locator('h1')).toHaveCount(1);await expect(page.locator('[data-reader-token]')).toBeVisible();expect(requests).toEqual([]);
  expect(await page.locator('body').innerHTML()).not.toContain(token);
  expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain(token);
  expect(await page.evaluate(()=>new URL(document.baseURI).pathname)).toBe(prefix?'/preview/':'/');
  await page.locator('[data-reader-token] button').click();await expect.poll(()=>requests.length).toBe(1);expect(requests).toEqual(['POST']);expect(payload).toEqual({token});expect(external).toEqual([]);
 });
}
