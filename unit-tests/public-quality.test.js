import {publicSkipHTML} from '../tools/public-skip-link.mjs';
// Synthetic Lighthouse report STUBS validate the checker; not browser evidence.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {checkPublicLighthouse,publicAssetSizes,writePublicQualityReport} from '../tools/public-quality-report.mjs';
const stub=()=>({categories:{performance:{score:.9},accessibility:{score:1},'best-practices':{score:1}},audits:{'largest-contentful-paint':{numericValue:3000},'cumulative-layout-shift':{numericValue:.02},'errors-in-console':{score:1},'label-content-name-mismatch':{score:1}}});
const reports=()=>Object.fromEntries(['home','latest','article','live'].map(name=>[name,stub()]));
test('report stubs must contain all real gate metrics; missing or failed reports cannot pass',()=>{
 assert.deepEqual(checkPublicLighthouse(reports()).failures,[]);
 const missing=reports();delete missing.live;assert.match(checkPublicLighthouse(missing).failures.join(),/live: missing/);
 const failed=reports();failed.article.runtimeError={code:'FAILED'};assert.match(checkPublicLighthouse(failed).failures.join(),/article: missing or failed/);
 const malformed=reports();delete malformed.home.audits;assert.match(checkPublicLighthouse(malformed).failures.join(),/LCP.*missing/);
});
test('performance, layout, accessibility and console regressions fail independently',()=>{
 const data=reports();data.home.categories.performance.score=.7;data.latest.categories.accessibility.score=.99;data.article.audits['cumulative-layout-shift'].numericValue=.2;data.live.audits['errors-in-console'].score=0;
 const failures=checkPublicLighthouse(data).failures.join(';');for(const value of ['home: performance','latest: accessibility','article: CLS','live: errors-in-console'])assert.ok(failures.includes(value));
});
async function fixture(t) {
 const dist=await mkdtemp(join(tmpdir(),'public-quality-stub-'));t.after(()=>rm(dist,{recursive:true,force:true}));
 await mkdir(join(dist,'site/assets'),{recursive:true});
 await writeFile(join(dist,'index.html'),'<script type="module" src="./site/assets/app.js"></script><link rel="stylesheet" href="./site/assets/app.css">');
 await writeFile(join(dist,'site/assets/app.js'),'console.log("synthetic asset stub")');await writeFile(join(dist,'site/assets/app.css'),'body{color:black}');await writeFile(join(dist,'site/assets/font.woff2'),'synthetic-font');return dist;
}
test('compiled asset measurement requires local real entries and measures gzip/font bytes',async t=>{
 const dist=await fixture(t),sizes=await publicAssetSizes(dist);assert.ok(sizes.initialJsGzipBytes>0);assert.ok(sizes.initialCssGzipBytes>0);assert.equal(sizes.fontBytes,14);
 await writeFile(join(dist,'index.html'),'<script src="https://remote.example.test/app.js"></script><link rel="stylesheet" href="./site/assets/app.css">');await assert.rejects(publicAssetSizes(dist),/escaped/);
});
test('passing metric stubs cannot bypass missing production journey evidence',async t=>{
 const dist=await fixture(t),output=await mkdtemp(join(tmpdir(),'quality-reports-stub-'));t.after(()=>rm(output,{recursive:true,force:true}));
 for(const [name,report] of Object.entries(reports()))await writeFile(join(output,name+'.json'),JSON.stringify(report));
 const result=await writePublicQualityReport({dist,output});assert.equal(result.passed,false);assert.match(result.failures.join(),/journey evidence is missing/);
});

test('SSR skip links stay local, focusable and idempotent',()=>{
 const html='<a class="skip-link" href="#main">Skip</a><main id="main" class="article"></main>';
 const rendered=publicSkipHTML(html,'/reports/synthetic/?private=unused');
 assert.match(rendered,/href="\/reports\/synthetic\/#main"/);assert.match(rendered,/<main id="main" tabindex="-1"/);assert.equal(publicSkipHTML(rendered,'/reports/synthetic/'),rendered);
 assert.doesNotMatch(publicSkipHTML(html,'http://public.invalid//outside.example.test/'),/href="\/\/outside/);
});
