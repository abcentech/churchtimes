import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const phase=process.argv[2] || 'after';
const base=process.env.AUDIT_BASE_URL || 'http://127.0.0.1:4173/';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const results={phase,layouts:[],accessibility:[],performance:[]};
for (const width of [320,360,390,430,768,1024,1440]) {
 const context=await browser.newContext({viewport:{width,height:900}}); const page=await context.newPage();
 for (const route of ['home','search/faith','saved','contact','advertise','latest','story/sowore-holds-private-meeting-with-pastor-adeboye-recounts-his-encounter']) {
  await page.goto(`${base}#${route}`); await page.evaluate(()=>document.fonts.ready);
  results.layouts.push({width,route,...await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,outside:[...document.querySelectorAll('main *,header *,footer *')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0 && (r.right>innerWidth+1 || r.left < -1) && getComputedStyle(el).position!=='absolute';}).slice(0,8).map(el=>el.className||el.tagName)}))});
 }
 await page.goto(base); await page.evaluate(()=>document.fonts.ready);
 if([320,390,1440].includes(width)) await page.screenshot({path:`${root}docs/mobile-quality/${phase}-${width}.png`});
 if(width===390){
  for(const route of ['home','contact','advertise','search/faith']){
   await page.goto(`${base}#${route}`);
   const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
   results.accessibility.push({route,violations:axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary})).slice(0,10)}))});
  }
 }
 await page.close();
}
for(let i=0;i<3;i++){
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
 await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:150000,uploadThroughput:75000});
 await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 await page.addInitScript(()=>{window.audit={lcp:0,cls:0};new PerformanceObserver(list=>{for(const e of list.getEntries())window.audit.lcp=e.startTime;}).observe({type:'largest-contentful-paint',buffered:true});new PerformanceObserver(list=>{for(const e of list.getEntries())if(!e.hadRecentInput)window.audit.cls+=e.value;}).observe({type:'layout-shift',buffered:true});});
 await page.goto(base,{waitUntil:'networkidle'});await page.waitForTimeout(1500);
 results.performance.push(await page.evaluate(()=>({...window.audit,resources:performance.getEntriesByType('resource').map(r=>({name:r.name.split('/').pop(),bytes:r.encodedBodySize})),totalBytes:performance.getEntriesByType('resource').reduce((sum,r)=>sum+r.encodedBodySize,0)})));
 await page.close();
}
await writeFile(`${root}docs/mobile-quality/${phase}.json`,JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({phase,overflow:results.layouts.filter(x=>x.overflow>0),accessibility:results.accessibility,performance:results.performance.map(({resources,...r})=>r)},null,2));
await browser.close();
