import {test,expect} from '@playwright/test';
test('Configured reader form module STUB failure keeps contact unavailable without legacy transport',async({page})=>{
  const challenges=[];page.on('request',request=>{if(request.url().includes('challenges.cloudflare.com'))challenges.push(request.url());});
  await page.route('**/src/forms/reader-forms.js*',route=>route.abort());
  await page.goto('/#contact');
  await expect(page.getByRole('heading',{name:'Online contact is unavailable'})).toBeVisible();
  await expect(page.locator('#public-form')).toHaveCount(0);expect(challenges).toEqual([]);
});
