// Baseline speed benchmark: Lighthouse mobile profile on Nigerian news front pages, plus ours when given.
// Polite by design: strictly sequential, one page load per site per run (front page only), a pause between
// sites, no crawling, no logins, no forms. Output stays local under private-reports/ (git-ignored):
// aggregate metrics only, no cookies, headers, screenshots or page content.
//
//   node tools/benchmark-competitors.mjs [--ours https://example.org/] [--runs 1] [--pause 15] [--only punchng.com,...] [--dry-run]
import lighthouse from 'lighthouse';
import {launch} from 'chrome-launcher';
import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
export const SITES=[
  'https://punchng.com/','https://www.vanguardngr.com/','https://www.premiumtimesng.com/','https://www.thecable.ng/',
  'https://guardian.ng/','https://www.channelstv.com/','https://dailytrust.com/','https://www.legit.ng/',
];
export const LIMITS={maxRuns:3,minPauseSeconds:5};
export function benchmarkOptions(argv) {
  const value=name=>{const i=argv.indexOf('--'+name);return i>=0?argv[i+1]:undefined;};
  const runs=Math.min(LIMITS.maxRuns,Math.max(1,Number(value('runs')||1)|0));
  const pause=Math.max(LIMITS.minPauseSeconds,Number(value('pause')||15));
  const only=value('only')?.split(',').map(s=>s.trim()).filter(Boolean);
  const sites=only?SITES.filter(url=>only.some(name=>new URL(url).hostname.replace(/^www\./,'')===name.replace(/^www\./,''))):[...SITES];
  const ours=value('ours');
  if(ours){const url=new URL(ours);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('--ours must be a plain http(s) URL');sites.unshift(url.href);}
  return {runs,pause,sites,ours:ours?new URL(ours).href:null,dryRun:argv.includes('--dry-run')};
}
const median=values=>{const list=values.filter(Number.isFinite).sort((a,b)=>a-b);return list.length?list[Math.floor((list.length-1)/2)]:null;};
export function summarize(lhr) {
  const audit=id=>lhr.audits[id]?.numericValue;
  return {performance:Math.round((lhr.categories.performance?.score??NaN)*100),fcpMs:audit('first-contentful-paint'),lcpMs:audit('largest-contentful-paint'),
    tbtMs:audit('total-blocking-time'),cls:audit('cumulative-layout-shift'),speedIndexMs:audit('speed-index'),
    totalBytes:audit('total-byte-weight'),requests:lhr.audits['network-requests']?.details?.items?.length??null,thirdPartyBytes:lhr.audits['third-party-summary']?.details?.summary?.wastedBytes??null};
}
export function aggregate(rows) {
  const keys=['performance','fcpMs','lcpMs','tbtMs','cls','speedIndexMs','totalBytes','requests'];
  return Object.fromEntries(keys.map(key=>[key,median(rows.map(row=>row[key]))]));
}
const wait=seconds=>new Promise(resolve=>setTimeout(resolve,seconds*1000));
async function main() {
  const options=benchmarkOptions(process.argv.slice(2));
  console.log(`Benchmark: ${options.sites.length} sites x ${options.runs} run(s), sequential, ${options.pause}s pause, Lighthouse mobile (simulated slow 4G, 4x CPU).`);
  for(const url of options.sites)console.log(' - '+url);
  if(options.dryRun)return;
  const output=resolve(fileURLToPath(new URL('../private-reports/',import.meta.url)),'benchmark-'+new Date().toISOString().slice(0,16).replace(/[:T]/g,'-'));
  await mkdir(output,{recursive:true});
  const chromePath=process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':chromium.executablePath());
  const results=[];
  for(const [index,url] of options.sites.entries()) {
    const runs=[];
    for(let run=0;run<options.runs;run++) {
      // A fresh browser per load: empty cache, no cookies carried between sites.
      const chrome=await launch({chromePath,chromeFlags:['--headless','--no-sandbox','--disable-dev-shm-usage']});
      try {
        const result=await lighthouse(url,{port:chrome.port,onlyCategories:['performance'],logLevel:'error',maxWaitForLoad:60000},{extends:'lighthouse:default',settings:{formFactor:'mobile',screenEmulation:{mobile:true,width:412,height:823,deviceScaleFactor:1.75,disabled:false}}});
        if(result.lhr.runtimeError)runs.push({error:result.lhr.runtimeError.code});else runs.push(summarize(result.lhr));
      } catch(error){runs.push({error:String(error.message||error).slice(0,120)});}
      finally {await chrome.kill();}
      if(run<options.runs-1)await wait(options.pause);
    }
    const ok=runs.filter(row=>!row.error);
    const row={site:new URL(url).hostname,ours:url===options.ours,runs:runs.length,failedRuns:runs.length-ok.length,...(ok.length?aggregate(ok):{}),errors:runs.filter(row=>row.error).map(row=>row.error)};
    results.push(row);console.log(JSON.stringify(row));
    if(index<options.sites.length-1)await wait(options.pause);
  }
  const report={kind:'Lighthouse '+(await import('lighthouse/package.json',{with:{type:'json'}})).default.version+' mobile, front page only, medians',measuredAt:new Date().toISOString(),runsPerSite:options.runs,results};
  await writeFile(join(output,'benchmark.json'),JSON.stringify(report,null,2)+'\n');
  const fmt=(v,d=0)=>v==null?'n/a':Number(v).toFixed(d);
  const lines=['| Site | Perf | FCP s | LCP s | TBT ms | CLS | Speed Index s | Page weight KB | Requests |','|---|---|---|---|---|---|---|---|---|',
    ...results.map(r=>`| ${r.site}${r.ours?' (ours)':''} | ${fmt(r.performance)} | ${fmt(r.fcpMs/1000,1)} | ${fmt(r.lcpMs/1000,1)} | ${fmt(r.tbtMs)} | ${fmt(r.cls,3)} | ${fmt(r.speedIndexMs/1000,1)} | ${fmt(r.totalBytes/1024)} | ${fmt(r.requests)} |`)];
  await writeFile(join(output,'benchmark.md'),`# Front-page speed benchmark\n\n${report.kind}. Measured ${report.measuredAt}. Lab numbers from one machine; compare relatively.\n\n${lines.join('\n')}\n`);
  console.log('Report written to '+output);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
