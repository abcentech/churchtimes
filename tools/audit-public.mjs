import {reportPath} from '../src/lib/public-routes.js';
// Reproducible mobile audits of compiled frontend + anonymous real CMS fixtures.
// Invoked by run-public-cms-tests.mjs while its disposable database is alive.
import {mkdir,writeFile,readdir,rename,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import lighthouse from 'lighthouse';
import {launch,killAll} from 'chrome-launcher';
import {chromium,devices} from '@playwright/test';
import {pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
// Prefer the browser installed by Playwright in CI; system Chromium may be a nonfunctional snap shim.
// An explicit override is authoritative so an operator gets a clear failure instead of an unexpected binary.
export function publicAuditChromePaths({override,bundled,exists=existsSync}={}) {
  if(override)return [override];
  return [...new Set([bundled,'/usr/bin/chromium','/usr/bin/google-chrome-stable'].filter(path=>path && exists(path)))];
}

export async function auditPublic({cmsUrl,dist,output,port,sourceRoot}) {
  await mkdir(output,{recursive:true});
  const fixture=await (await fetch(cmsUrl+'/__test/fixtures')).json();
  const {createPublicServer}=await import(pathToFileURL(join(sourceRoot,'tools/serve-public.mjs')).href);
  // Same production layout as npm run build / prepare-pages.mjs.
  await mkdir(join(dist,'site'),{recursive:true});
  for(const file of await readdir(dist))if(!['site','index.html'].includes(file))await rename(join(dist,file),join(dist,'site',file));
  const html=await readFile(join(dist,'index.html'),'utf8');
  await writeFile(join(dist,'index.html'),html.replace(/(src|href)="\.\//g,'$1="./site/'));
  const server=createPublicServer({cmsUrl,dist,siteUrl:'https://staging-public.example.test',articlePathTemplate:'/reports/{slug}/'});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const candidates=publicAuditChromePaths({override:process.env.CHROMIUM_PATH,bundled:chromium.executablePath()});
  let chrome,chromePath,launchError;
  const results=[];
  const pages=[['home','/'],['latest','/#latest'],['article',reportPath(fixture.publishedSlug,'/',process.env.PUBLIC_ARTICLE_PATH_TEMPLATE)],['live','/#live']];
  try {
    for(const candidate of candidates) {
      try {chrome=await launch({chromePath:candidate,chromeFlags:['--headless','--no-sandbox','--disable-dev-shm-usage']});chromePath=candidate;break;}
      catch(error) {launchError=error;killAll();}
    }
    if(!chrome)throw new Error('Could not start an audit browser: '+(launchError?.message || 'no Chromium executable found'));
    console.log('Audit browser started: '+(chromePath===chromium.executablePath()?'Playwright Chromium':'configured or system Chromium'));
    if(process.env.PUBLIC_QUALITY_GATE==='true') {
      const {checkPublicJourneys}=await import('./public-quality-journeys.mjs');
      const journeys=await checkPublicJourneys({origin,fixture,output,chromePath,cmsUrl});
      if(journeys.some(row=>!row.passed))throw new Error('Production browser journey gate failed; inspect journeys.json');
    }
    if(process.env.PUBLIC_AUDIT_ONLY_SCREENSHOTS!=='true') for(const [name,path] of pages) {
      const result=await lighthouse(origin+path,{port:chrome.port,output:['json','html'],onlyCategories:['performance','accessibility','best-practices','seo'],logLevel:'error'},{extends:'lighthouse:default',settings:{formFactor:'mobile',screenEmulation:{mobile:true,width:412,height:823,deviceScaleFactor:1.75,disabled:false}}});
      await writeFile(join(output,name+'.json'),result.report[0]);
      await writeFile(join(output,name+'.html'),result.report[1]);
      const lhr=result.lhr;
      if(lhr.runtimeError)throw new Error(name+': '+lhr.runtimeError.message);
      const row={page:name,url:lhr.finalDisplayedUrl,scores:Object.fromEntries(Object.entries(lhr.categories).map(([key,value])=>[key,Math.round(value.score*100)])),lcp:lhr.audits['largest-contentful-paint'].numericValue,cls:lhr.audits['cumulative-layout-shift'].numericValue,failures:Object.entries(lhr.audits).filter(([,v])=>v.score!==null&&v.score<1).map(([id,v])=>({id,score:v.score,details:v.details}))};
      results.push(row);console.log(name,JSON.stringify({...row,failures:row.failures.map(f=>f.id)}));
    }
    await writeFile(join(output,'summary.json'),JSON.stringify(results,null,2));
    // Report only (never a gate): INP proxy from real taps on a throttled mobile profile.
    if(process.env.PUBLIC_AUDIT_ONLY_SCREENSHOTS!=='true')try {const {reportResponsiveness}=await import('./public-responsiveness.mjs');console.log('responsiveness',JSON.stringify((await reportResponsiveness({origin,output,chromePath,articlePath:pages[2][1]})).rows));} catch(error){console.error('Responsiveness report unavailable (non-failing): '+error.message);}
    if(process.env.PUBLIC_QUALITY_GATE==='true') {
      const {writePublicQualityReport}=await import('./public-quality-report.mjs');
      const report=await writePublicQualityReport({output,dist});
      if(!report.passed)throw new Error('Public quality gate failed: '+report.failures.join('; '));
    }
    if(process.env.PUBLIC_AUDIT_SCREENSHOTS==='true') {
      const browser=await chromium.launch({executablePath:chromePath,args:['--no-sandbox']});
      try {
        for(const [size,device] of [['desktop',{viewport:{width:1440,height:1000}}],['android',{...devices['Pixel 7'],deviceScaleFactor:1}]]) {
          const context=await browser.newContext(device),page=await context.newPage();
          for(const [name,path] of pages) {
            await page.goto(origin+path);
            if(name==='home')await page.locator('.lead-story h1').waitFor();
            if(name==='latest')await page.locator('#newsroom-grid').getByText(fixture.runId,{exact:false}).first().waitFor();
            if(name==='article')await page.locator('.article-header h1').waitFor();
            if(name==='live')await page.locator('.live-event-links').getByText(fixture.liveTitle,{exact:false}).waitFor();
            await page.evaluate(async()=>{await document.fonts.ready;for(const image of document.images)image.loading='eager';await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));});
            if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error(name+' overflows '+size);
            await page.screenshot({path:join(output,name+'-'+size+'.png')});
            if(name==='article')await page.screenshot({path:join(output,name+'-full-'+size+'.png'),fullPage:true});
          }
          await context.close();
        }
      } finally {await browser.close();}
    }
  } finally {
    if(chrome)chrome.kill();else killAll();
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});
  }
}
