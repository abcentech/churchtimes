import {readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {gzipSync} from 'node:zlib';
import budgets from './public-quality-budgets.json' with {type:'json'};
export function checkPublicLighthouse(reports,limits=budgets) {
  const failures=[],pages=[];
  for(const name of limits.pages) {
    const report=reports[name];
    if(!report || report.runtimeError){failures.push(name+': missing or failed Lighthouse run');continue;}
    const score=key=>report.categories?.[key]?.score;
    const lcp=report.audits?.['largest-contentful-paint']?.numericValue,cls=report.audits?.['cumulative-layout-shift']?.numericValue;
    // tbtMs/fcpMs are reported, never gated (lab responsiveness proxy; see responsiveness.json for the INP proxy).
    const result={page:name,performance:Math.round(score('performance')*100),accessibility:Math.round(score('accessibility')*100),bestPractices:Math.round(score('best-practices')*100),lcpMs:lcp,cls,tbtMs:report.audits?.['total-blocking-time']?.numericValue??null,fcpMs:report.audits?.['first-contentful-paint']?.numericValue??null};
    for(const [key,min] of [['performance',limits.minPerformance],['accessibility',limits.minAccessibility],['best-practices',limits.minBestPractices]])if(!Number.isFinite(score(key)) || score(key)*100<min)failures.push(name+': '+key+' below '+min);
    if(!Number.isFinite(lcp)||lcp>limits.maxLcpMs)failures.push(name+': LCP exceeds budget or is missing');
    if(!Number.isFinite(cls)||cls>limits.maxCls)failures.push(name+': CLS exceeds budget or is missing');
    for(const key of ['errors-in-console','label-content-name-mismatch'])if(report.audits?.[key]?.score!==1)failures.push(name+': '+key+' failed or is missing');
    pages.push(result);
  }
  return {failures,pages};
}
export async function publicAssetSizes(dist) {
  const root=resolve(dist),html=await readFile(join(root,'index.html'),'utf8');
  const size=async href=>{
    const url=new URL(href,'https://public.invalid/');
    const file=resolve(root,'.'+decodeURIComponent(url.pathname));
    if(url.origin!=='https://public.invalid'||!file.startsWith(root+sep))throw new Error('Initial asset escaped the build directory');
    return gzipSync(await readFile(file)).byteLength;
  };
  const scripts=[...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(match=>match[1]);
  const styles=[...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map(match=>match[1]);
  if(!scripts.length || !styles.length)throw new Error('Compiled initial JS/CSS entry is missing');
  let fontBytes=0;
  async function fonts(directory) {for(const name of await readdir(directory)){const file=join(directory,name),info=await stat(file);if(info.isDirectory())await fonts(file);else if(/\.woff2?$/.test(name))fontBytes+=info.size;}}
  await fonts(join(root,'site','assets'));
  return {initialJsGzipBytes:(await Promise.all(scripts.map(size))).reduce((a,b)=>a+b,0),initialCssGzipBytes:(await Promise.all(styles.map(size))).reduce((a,b)=>a+b,0),fontBytes};
}
export async function writePublicQualityReport({output,dist}) {
  const reports={};
  for(const name of budgets.pages)try {reports[name]=JSON.parse(await readFile(join(output,name+'.json'),'utf8'));}catch{}
  const report=checkPublicLighthouse(reports);
  try {
    report.assets=await publicAssetSizes(dist);
    for(const [key,max] of [['initialJsGzipBytes',budgets.maxInitialJsGzipBytes],['initialCssGzipBytes',budgets.maxInitialCssGzipBytes],['fontBytes',budgets.maxFontBytes]])if(report.assets[key]>max)report.failures.push(key+' exceeds '+max);
  } catch {report.failures.push('Compiled asset budget could not be measured');}
  try {
    report.journeys=JSON.parse(await readFile(join(output,'journeys.json'),'utf8'));
    if(!Array.isArray(report.journeys) || report.journeys.length!==8 || report.journeys.some(row=>!row.passed) || budgets.pages.some(page=>['desktop','mobile'].some(device=>report.journeys.filter(row=>row.page===page&&row.device===device).length!==1)))report.failures.push('Production browser journeys did not all pass');
  } catch {report.failures.push('Production browser journey evidence is missing');}
  report.kind='real Payload REST + disposable PostgreSQL; synthetic article metadata; external Turnstile transport STUBBED and unused';
  report.passed=report.failures.length===0;report.budgets=budgets;report.completedAt=new Date().toISOString();
  // Only numeric/boolean aggregates: no DOM dumps, personal data, tokens or URLs.
  await writeFile(join(output,'quality.json'),JSON.stringify(report,null,2)+'\n');
  return report;
}
