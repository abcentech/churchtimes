import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('Copy fallback remains accessible and local Listen is available',async({page})=>{
  await page.addInitScript(()=>{
    // STUB browser speech transport; no audio or network provider is invoked.
    window.SpeechSynthesisUtterance=class { constructor(text){this.text=text;} };
    window.stubVoices=[];window.speechSynthesis.getVoices=()=>window.stubVoices;
    window.speechSynthesis.speak=speech=>{window.spokenText=speech.text;};window.speechSynthesis.cancel=()=>{};
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw Error('STUB denied');}},configurable:true});
  });
  await page.goto('/');
  const href=await page.locator('.lead-story h1 a').getAttribute('href');await page.goto('/'+href);
  await expect(page.getByRole('button',{name:'Listen',exact:true})).toBeHidden();
  await page.locator('.article-body').evaluate(body=>{const ad=document.createElement('aside');ad.className='advertising-slot';ad.textContent='Advertisement Synthetic Sponsor';body.append(ad);});
  await page.evaluate(()=>{window.stubVoices=[{localService:true,lang:'en-GB'}];window.speechSynthesis.dispatchEvent(new Event('voiceschanged'));});
  await page.getByRole('button',{name:'Listen',exact:true}).click();
  const spoken=await page.evaluate(()=>window.spokenText);expect(spoken).not.toContain('CONTINUE READING');expect(spoken).not.toContain('Advertisement');expect(spoken).not.toContain('Synthetic Sponsor');await expect(page.getByRole('button',{name:'Stop listening'})).toBeVisible();
  await page.getByRole('button',{name:'Copy original article link'}).click();
  await expect(page.getByRole('dialog',{name:'Share this story'})).toBeVisible();await page.getByRole('button',{name:'Copy link',exact:true}).click();
  await expect(page.locator('#share-status')).toContainText('link is selected');
  await page.mouse.move(0,0);await page.locator('#copy-share-url').evaluate(async button=>{await Promise.allSettled(button.getAnimations().map(animation=>animation.finished));});
  const results=await new AxeBuilder({page}).include('#share-dialog').analyze();expect(results.violations).toEqual([]);
});
