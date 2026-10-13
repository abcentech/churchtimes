import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
const output=new URL('../docs/homepage-advertising/',import.meta.url);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox']});
const result={method:{runs:3,viewport:[390,844],latencyMs:150,downloadBytesPerSecond:150000,uploadBytesPerSecond:75000,cpuThrottle:4,cache:'disabled',cms:false,activeCampaigns:0},before:[],after:[],layouts:[]};
for(const [phase,base] of [['before',process.env.BASELINE_BASE_URL || 'http://127.0.0.1:5190/'],['after',process.env.AUDIT_BASE_URL || 'http://127.0.0.1:4173/']]){
 for(let run=0;run<3;run++){
  const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();
  const cdp=await context.newCDPSession(page);
  await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:150000,uploadThroughput:75000});
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  await page.addInitScript(()=>{window.measured={lcp:0,cls:0};new PerformanceObserver(list=>{for(const entry of list.getEntries())window.measured.lcp=entry.startTime;}).observe({type:'largest-contentful-paint',buffered:true});new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!entry.hadRecentInput)window.measured.cls+=entry.value;}).observe({type:'layout-shift',buffered:true});});
  await page.goto(base,{waitUntil:'networkidle'});await page.waitForTimeout(1500);
  result[phase].push(await page.evaluate(()=>({...window.measured,resourceBytes:performance.getEntriesByType('resource').reduce((sum,entry)=>sum+entry.encodedBodySize,0),requests:performance.getEntriesByType('resource').length})));
  await context.close();
 }
 for(const width of [390,1440]){
  const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1,isMobile:width===390,hasTouch:width===390});const page=await context.newPage();
  await page.goto(base);await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(async()=>{const images=[...document.images];images.forEach(image=>image.loading='eager');await Promise.all(images.map(image=>image.decode().catch(()=>{})));});
  const stories=await page.locator('main h1 a[href^="#story/"],main h2 a[href^="#story/"],main h3 a[href^="#story/"]').evaluateAll(els=>els.map(el=>el.getAttribute('href')));
  result.layouts.push({phase,width,storyAppearances:stories.length,uniqueStories:new Set(stories).size,height:await page.evaluate(()=>document.documentElement.scrollHeight)});
  if(phase==='before')await page.screenshot({path:new URL(`before-${width}.png`,output).pathname,fullPage:true});
  await context.close();
 }
}
await writeFile(new URL('performance.json',output),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));await browser.close();
