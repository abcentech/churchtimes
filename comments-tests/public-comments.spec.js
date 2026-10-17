import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const entry={id:7,authorName:'Synthetic Reader',content:'Archived synthetic text.\nA second line.',commentedAt:'2023-05-10T11:00:00Z',parentLegacyId:null,email:'PRIVATE_FIELD@example.test',website:'https://private.example.test',ip:'PRIVATE-IP'};
const payload=(docs=[entry],hasNextPage=false,nextPage=null)=>({docs,hasNextPage,nextPage});
// Every API response below is a labelled C6 contract STUB; no real CMS endpoint is involved.
async function stub(page,handler=()=>({status:200,body:payload()})) {
  const calls=[];
  await page.route('**/api/legacy-comments?**',async route=>{calls.push(new URL(route.request().url()));const result=await handler(calls.length,calls.at(-1));await route.fulfill({status:result.status,headers:{'Content-Type':'application/json',...(result.headers||{})},body:JSON.stringify(result.body)});});
  return calls;
}
test('readonly projection renders text, dates and no email fields/HTML/links (STUB)',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const calls=await stub(page,()=>({status:200,body:payload([{...entry,authorName:'Synthetic <img src=x onerror=alert(1)>',content:'<script>alert(1)</script>\nhttps://unsafe.example.test <a href="javascript:x">plain</a>'}])}));
  await page.goto('/comments-tests/harness.html');await expect(page.locator('[data-comments-list] li')).toHaveCount(1);
  await expect(page.locator('[data-comments-list]')).toContainText('<script>alert(1)</script>');await expect(page.locator('[data-comments-list] img, [data-comments-list] script, [data-comments-list] a')).toHaveCount(0);
  expect(await page.locator('[data-comments-list]').innerHTML()).not.toContain('PRIVATE_FIELD');expect(await page.locator('[data-comments-list]').innerHTML()).not.toContain('PRIVATE-IP');
  expect(await page.locator('[data-comments-list] .comment-content').evaluate(el=>getComputedStyle(el).whiteSpace)).toBe('pre-line');
  expect(calls[0].searchParams.get('where[article][equals]')).toBe('42');expect(calls[0].searchParams.get('limit')).toBe('100');expect(calls[0].searchParams.get('sort')).toBe('commentedAt');
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','best-practice']).analyze();expect(axe.violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
  expect(await page.evaluate(()=>Object.keys(localStorage).concat(Object.keys(sessionStorage)))).toEqual([]);
});
test('pagination is reader-triggered, deduplicates and leaves keyboard focus visible (STUB)',async({page})=>{
  const calls=await stub(page,n=>({status:200,body:n===1?payload([entry],true,2):payload([entry,{...entry,id:8,authorName:'Another Synthetic Reader',parentLegacyId:123}])}));
  await page.goto('/comments-tests/harness.html');const more=page.getByRole('button',{name:'Load more archived comments',exact:true});await expect(more).toBeVisible();expect(calls).toHaveLength(1);
  await more.focus();await page.keyboard.press('Enter');await expect(page.locator('[data-comments-list] li')).toHaveCount(2);expect(calls).toHaveLength(2);expect(calls[1].searchParams.get('page')).toBe('2');
  await expect(page.locator('[data-comments-status]')).toBeFocused();await expect(page.locator('[data-comments-status]')).toHaveText('2 archived comments shown.');await expect(more).toBeHidden();
});
for(const status of [400,403,404,429,500,503])test(`HTTP ${status} has an honest unavailable state and no retry loop (STUB)`,async({page})=>{
  const calls=await stub(page,()=>({status,body:{errors:[{message:'PRIVATE server message'}]},headers:{'Retry-After':'9999999999'}}));
  await page.goto('/comments-tests/harness.html');await expect(page.locator('[data-comments-status]')).toContainText(status===429?'busy':'temporarily unavailable');await expect(page.locator('[data-comments-status]')).not.toContainText('No archived comments');await expect(page.locator('[data-comments-status]')).not.toContainText('PRIVATE');expect(calls).toHaveLength(1);
  if(status===429)await expect(page.getByRole('button',{name:/Try loading comments again in/})).toBeDisabled();
});
test('empty archive is distinct from HTTP failure and has no empty loading gap (STUB)',async({page})=>{
  await stub(page,()=>({status:200,body:payload([])}));await page.goto('/comments-tests/harness.html');await expect(page.locator('[data-comments-status]')).toHaveText('No archived comments are available for this article.');await expect(page.locator('[data-comments-list] li')).toHaveCount(0);await expect(page.getByRole('button',{name:/loading comments again/})).toBeHidden();
});
test('unset configuration and invalid published IDs make no API request (STUB)',async({page})=>{
  const calls=await stub(page);for(const query of ['?disabled=1','?article=draft-slug','?article=-1']){await page.goto('/comments-tests/harness.html'+query);await expect(page.locator('[data-public-comments]')).toHaveCount(0);}expect(calls).toHaveLength(0);
});
test('one explicit retry recovers without losing the retained archive (STUB)',async({page})=>{
  const calls=await stub(page,n=>({status:n===1?503:200,body:n===1?{}:payload()}));await page.goto('/comments-tests/harness.html');const retry=page.getByRole('button',{name:'Try loading comments again',exact:true});await expect(retry).toBeVisible();await retry.focus();await page.keyboard.press('Enter');await expect(page.locator('[data-comments-list] li')).toHaveCount(1);await expect(page.locator('[data-comments-status]')).toBeFocused();expect(calls).toHaveLength(2);
});
test('navigation disposal cancels a delayed response without a fabricated result (STUB)',async({page})=>{
  let release;const wait=new Promise(resolve=>release=resolve);await stub(page,async()=>{await wait;return {status:200,body:payload()};});await page.goto('/comments-tests/harness.html');await expect(page.locator('[data-public-comments]')).toBeVisible();await page.evaluate(()=>{window.disposeComments();document.querySelector('[data-public-comments]').remove();});release();await expect(page.locator('[data-public-comments]')).toHaveCount(0);
});
test('malformed and explicitly hidden records never become a false empty success (STUB)',async({page})=>{
  await stub(page,()=>({status:200,body:payload([{...entry,status:'hidden'}])}));await page.goto('/comments-tests/harness.html');await expect(page.locator('[data-comments-status]')).toContainText('temporarily unavailable');await expect(page.locator('[data-comments-list] li')).toHaveCount(0);
});
test('a stalled archive read times out honestly without automatic retries (STUB)',async({page})=>{
  let release;const wait=new Promise(resolve=>release=resolve);const calls=await stub(page,async()=>{await wait;return {status:200,body:payload()};});await page.goto('/comments-tests/harness.html?timeout=1');await expect(page.locator('[data-comments-status]')).toContainText('took too long');expect(calls).toHaveLength(1);release();
});
