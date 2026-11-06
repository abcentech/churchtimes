// Non-failing responsiveness report: an INP proxy from real interactions on a throttled mobile profile.
// Lighthouse navigation runs cannot measure INP (no interactions), so TBT stays the lab proxy in quality.json
// and this adds measured interaction latency. It never fails the gate; it writes responsiveness.json only.
import {chromium,devices} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export const CPU_SLOWDOWN=4;
// Interactions a reader really performs; each is a click/tap on an existing control.
export const INTERACTIONS=[
  ['home','/','[data-menu]','Open sections menu'],
  ['home','/','[data-search]','Open search'],
  ['article',null,'[data-lite-toggle]','Data saver toggle'],
];
// Largest event duration per interaction (the INP definition, without the p98 cut for few interactions).
export function inpFromEntries(entries) {
  const byInteraction=new Map();
  for(const entry of entries)if(entry.interactionId)byInteraction.set(entry.interactionId,Math.max(byInteraction.get(entry.interactionId)||0,entry.duration));
  const values=[...byInteraction.values()].sort((a,b)=>b-a);
  return values.length?values[0]:null;
}
export async function reportResponsiveness({origin,output,chromePath,articlePath}) {
  const browser=await chromium.launch({executablePath:chromePath,args:['--no-sandbox','--disable-dev-shm-usage']});
  const rows=[];
  try {
    for(const [page,path,selector,label] of INTERACTIONS) {
      const context=await browser.newContext(devices['Pixel 7']),tab=await context.newPage();
      const row={page,interaction:label,cpuSlowdown:CPU_SLOWDOWN,inpMs:null};
      try {
        const cdp=await context.newCDPSession(tab);await cdp.send('Emulation.setCPUThrottlingRate',{rate:CPU_SLOWDOWN});
        await tab.addInitScript(()=>{window.__events=[];new PerformanceObserver(list=>{for(const e of list.getEntries())window.__events.push({interactionId:e.interactionId,duration:e.duration});}).observe({type:'event',durationThreshold:16,buffered:true});});
        await tab.goto(origin+(path??articlePath));await tab.waitForLoadState('load');await tab.waitForTimeout(1500);
        await tab.locator(selector).first().scrollIntoViewIfNeeded();await tab.locator(selector).first().tap();
        await tab.waitForTimeout(800);
        row.inpMs=inpFromEntries(await tab.evaluate(()=>window.__events));
        // Under the 16 ms reporting threshold the browser records nothing: the interaction was faster than that.
        if(row.inpMs===null)row.inpMs=0;
      } catch(error) {row.error=String(error.message||error).slice(0,120);} finally {await context.close();}
      rows.push(row);
    }
  } finally {await browser.close();}
  const report={kind:'INP proxy (max event duration per interaction), Pixel 7 emulation, CPU x'+CPU_SLOWDOWN+'; report only, never a gate',goodMs:200,rows,completedAt:new Date().toISOString()};
  await writeFile(join(output,'responsiveness.json'),JSON.stringify(report,null,2)+'\n');
  return report;
}
