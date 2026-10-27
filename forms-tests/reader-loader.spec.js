import {test,expect} from '@playwright/test';
test('Configured reader form module STUB failure keeps contact unavailable without legacy transport',async({page})=>{
  const challenges=[];page.on('request',request=>{if(request.url().includes('challenges.cloudflare.com'))challenges.push(request.url());});
  await page.route('**/src/forms/reader-forms.js*',route=>route.abort());
  await page.goto('/#contact');
  await expect(page.getByRole('heading',{name:'Online contact is unavailable'})).toBeVisible();
  await expect(page.locator('#public-form')).toHaveCount(0);expect(challenges).toEqual([]);
});

test('A stalled reader form chunk never blocks first paint or navigation; the form fills in when it arrives',async({page})=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  await page.route('**/src/forms/reader-forms.js*',async route=>{await held;await route.continue();});
  await page.goto('/#contact',{waitUntil:'domcontentloaded'});
  // The page is rendered and interactive while the chunk is still held.
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.getByText('Loading the contact form…')).toBeVisible();
  await page.getByRole('link',{name:'Advertise',exact:true}).first().click();
  await expect(page.getByRole('heading',{name:'A considered audience. A meaningful conversation.'})).toBeVisible();
  await page.getByRole('link',{name:'Contact',exact:true}).first().click();
  await expect(page.getByText('Loading the contact form…')).toBeVisible();
  release();
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page.getByText('Loading the contact form…')).toHaveCount(0);
});
