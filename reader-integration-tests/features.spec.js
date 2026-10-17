import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mkdir} from 'node:fs/promises';
async function evidence(page,testInfo,selector,name){if(!process.env.PUBLIC_READER_SCREENSHOTS)return;await mkdir('docs/evidence/wave3-reader-integration',{recursive:true});await page.locator(selector).screenshot({path:`docs/evidence/wave3-reader-integration/${name}-${testInfo.project.name}.png`});}
const article={id:9,status:'published',slug:'synthetic-reader-report',title:'Synthetic reader report',excerpt:'Synthetic integration STUB fixture.',publishedAt:'2026-10-16T12:00:00Z',category:{title:'News'},content:{root:{children:[{type:'paragraph',children:[{type:'text',text:'Synthetic published article body for reader feature tests.'}]}]}}};
async function stubArticle(page){await page.route('**/api/articles?**',route=>route.fulfill({json:{docs:[article],hasNextPage:false}}));}
test('Published article mounts the archived comment projection as escaped text only (CMS STUB)',async({page},testInfo)=>{
  await stubArticle(page);const urls=[];
  await page.route('**/api/legacy-comments?**',route=>{urls.push(new URL(route.request().url()));return route.fulfill({json:{docs:[{id:1,authorName:'Synthetic reader',content:'<script>unsafe</script> Plain archived text.',commentedAt:'2026-10-15T12:00:00Z',email:'PRIVATE-STUB@example.test'}],hasNextPage:false}});});
  await page.goto('/reports/synthetic-reader-report/');await expect(page.getByRole('heading',{name:'Archived comments'})).toBeVisible();await expect(page.locator('.comment-content')).toContainText('<script>unsafe</script>');
  expect(urls[0].searchParams.get('where[article][equals]')).toBe('9');expect(await page.locator('.public-comments').innerHTML()).not.toContain('PRIVATE-STUB');await expect(page.locator('.public-comments script')).toHaveCount(0);
  expect((await new AxeBuilder({page}).include('.public-comments').analyze()).violations).toEqual([]);await evidence(page,testInfo,'.public-comments','archived-comments');
  await page.getByRole('link',{name:'Advertise',exact:true}).first().click();await expect(page.locator('.public-comments')).toHaveCount(0);await expect(page.getByRole('heading',{name:'A considered audience. A meaningful conversation.'})).toBeVisible();
});
test('Privacy shell keeps configured push inert until an explicit checked choice and button (SDK STUB)',async({page},testInfo)=>{
  const requests=[];await stubArticle(page);
  await page.addInitScript(()=>{
    // STUB notification/service-worker transport: no real permission prompt or registration.
    window.stubPushTrace=[];Object.defineProperty(window,'Notification',{configurable:true,value:{permission:'default'}});
    Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{getRegistrations:async()=>[]}});
  });
  await page.route('https://cdn.onesignal.com/**',route=>{requests.push(route.request().url());return route.fulfill({contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:`(async()=>{const provider={init:async()=>{},Notifications:{permission:true,requestPermission:async()=>window.stubPushTrace.push('permission')},User:{PushSubscription:{optOut:async()=>window.stubPushTrace.push('optout')}}};for(const callback of window.OneSignalDeferred||[])await callback(provider);})();`});});
  await page.goto('/');await page.getByRole('button',{name:'Privacy & reading list'}).click();await expect(page.getByRole('button',{name:'Enable notifications'})).toBeVisible();expect(requests).toEqual([]);
  await page.getByRole('button',{name:'Enable notifications'}).click();await expect(page.getByLabel('Allow optional push notifications')).toBeFocused();expect(requests).toEqual([]);
  await page.getByLabel('Allow optional push notifications').check();expect(requests).toEqual([]);await page.getByRole('button',{name:'Enable notifications'}).click();await expect(page.locator('[data-public-push] [role="status"]')).toContainText('Notifications are enabled');expect(requests).toHaveLength(1);
  await page.getByLabel('Allow optional push notifications').uncheck();await expect.poll(()=>page.evaluate(()=>window.stubPushTrace.includes('optout'))).toBe(true);
  expect((await new AxeBuilder({page}).include('#privacy-dialog').analyze()).violations).toEqual([]);await evidence(page,testInfo,'#privacy-dialog','push-privacy');
});
