import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { configureAds } from '../advertising-tests/fixtures.js';
const output=new URL('../docs/homepage-advertising/',import.meta.url);
await mkdir(output,{recursive:true});
const base=process.env.CAPTURE_BASE_URL || 'http://127.0.0.1:5177/';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox']});
const results=[];
for(const width of [390,1440]){
 for(const paid of [false,true]){
  const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1,isMobile:width===390,hasTouch:width===390});
  const page=await context.newPage();
  if(paid)await configureAds(page);
  await page.goto(base);await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(async()=>{const images=[...document.images];images.forEach(image=>image.loading='eager');await Promise.all(images.map(image=>image.decode().catch(()=>{})));});
  await page.screenshot({path:new URL(`after-${paid?'demo-campaign':'unsold'}-${width}.png`,output).pathname,fullPage:true});
  if(!paid){
   const stories=await page.locator('main h1 a[href^="#story/"],main h2 a[href^="#story/"],main h3 a[href^="#story/"]').evaluateAll(els=>els.map(el=>el.getAttribute('href')));
   results.push({width,storyAppearances:stories.length,uniqueStories:new Set(stories).size,height:await page.evaluate(()=>document.documentElement.scrollHeight)});
  }else{
   await page.goto(`${base}#story/sowore-holds-private-meeting-with-pastor-adeboye-recounts-his-encounter`);
   await page.locator('[data-ad-placement="article-inline"]').scrollIntoViewIfNeeded();
   await page.evaluate(()=>document.fonts.ready);
   await page.screenshot({path:new URL(`after-demo-article-${width}.png`,output).pathname});
  }
  await context.close();
 }
}
await writeFile(new URL('after-layout.json',output),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results));
await browser.close();
