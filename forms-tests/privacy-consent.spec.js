import {test,expect} from '@playwright/test';
test('Configured story permission and the real privacy checkbox stay synchronised (Turnstile STUB)',async({page})=>{
 let requests=0;
 await page.route('https://challenges.cloudflare.com/turnstile/**',route=>{requests++;return route.fulfill({contentType:'text/javascript',body:'/* STUB transport */ window.turnstile={render(){return "synthetic";},remove(){},reset(){}};'});});
 await page.goto('/#submit');await expect(page.getByRole('button',{name:'Allow spam protection',exact:true})).toBeEnabled();expect(requests).toBe(0);
 await page.getByRole('button',{name:'Allow spam protection',exact:true}).click();await expect.poll(()=>requests).toBe(1);
 await page.getByRole('button',{name:'Privacy & reading list'}).click();
 await expect(page.getByLabel('Allow Cloudflare spam protection for online forms')).toBeChecked();
 await page.getByLabel('Allow Cloudflare spam protection for online forms').uncheck();
 await page.getByRole('button',{name:'Close privacy notice'}).click();
 await expect(page.getByRole('button',{name:'Allow spam protection',exact:true})).toBeVisible();
});
