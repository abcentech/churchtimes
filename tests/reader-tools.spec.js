import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('Copy fallback remains accessible and local Listen is available',async({page})=>{
  await page.addInitScript(()=>{
    // STUB browser speech transport; no audio or network provider is invoked.
    window.SpeechSynthesisUtterance=class { constructor(text){this.text=text;} };
    window.speechSynthesis.getVoices=()=>[{localService:true,lang:'en-GB'}];
    window.speechSynthesis.speak=()=>{};window.speechSynthesis.cancel=()=>{};
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw Error('STUB denied');}},configurable:true});
  });
  await page.goto('/');
  const href=await page.locator('.lead-story h1 a').getAttribute('href');await page.goto('/'+href);
  await page.getByRole('button',{name:'Listen',exact:true}).click();await expect(page.getByRole('button',{name:'Stop listening'})).toBeVisible();
  await page.getByRole('button',{name:'Copy original article link'}).click();
  await expect(page.getByRole('dialog',{name:'Share this story'})).toBeVisible();await page.getByRole('button',{name:'Copy link',exact:true}).click();
  await expect(page.locator('#share-status')).toContainText('link is selected');
  const results=await new AxeBuilder({page}).include('#share-dialog').analyze();expect(results.violations).toEqual([]);
});
