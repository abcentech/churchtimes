import {writeFile} from 'node:fs/promises';
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const cms=process.env.PUBLIC_CMS_TEST_URL,ssr=process.env.PUBLIC_SSR_TEST_URL;
test('50 synthetic historical articles render through real CMS REST on a mobile/desktop browser',async({page,request},testInfo)=>{
 test.skip(process.env.PUBLIC_LEGACY_SAMPLES!=='true','Run PUBLIC_LEGACY_SAMPLES=true npm run test:cms to create the explicit synthetic corpus.');
 test.setTimeout(180000);
 const fixture=await (await request.get(cms+'/__test/fixtures')).json();expect(fixture.legacySamples).toHaveLength(50);
 const faults=[];page.on('pageerror',error=>faults.push(error.message));page.on('console',message=>{if(message.type()==='error')faults.push(message.text());});
 const checked=[];
 for(const sample of fixture.legacySamples) {
  const response=await page.goto(ssr+'/reports/'+sample.slug+'/');expect(response.status()).toBe(200);
  await expect(page.locator('.article-header h1')).toHaveText(sample.title);
  const body=page.locator('.newsroom-article-body');await expect(body).toContainText('Synthetic archived narrative');
  await expect(body.locator('table')).toHaveCount(1);await expect(body.locator('th[scope="col"]')).toHaveCount(2);await expect(body.locator('th[scope="row"]')).toHaveCount(1);
  await expect(body.locator('a[href^="https://example.test/"]')).toHaveCount(1);
  await expect(body.locator('figcaption')).toContainText('CMS integration caption');
  await expect(body.locator('img')).toHaveAttribute('srcset',/\d+w/);
  await expect(body.locator('img')).toHaveJSProperty('complete',true);expect(await body.locator('img').evaluate(image=>image.naturalWidth)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.evaluate(()=>window.legacyLeak)).toBeUndefined();expect(await body.locator('script,iframe,a[href^="javascript:"]').count()).toBe(0);
  const axe=await new AxeBuilder({page}).include('#cms-report').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();expect(axe.violations).toEqual([]);
  checked.push({index:sample.index,title:sample.title,slug:sample.slug,overflow:false,accessibilityViolations:0});
 }
 expect(faults).toEqual([]);
 const evidence=JSON.stringify({kind:'real Payload REST with synthetic article data; Turnstile transport STUBBED and unused',project:testInfo.project.name,checked},null,2);
 const path=testInfo.outputPath('synthetic-legacy-corpus.json');await writeFile(path,evidence);
 await testInfo.attach('synthetic-legacy-corpus.json',{path,contentType:'application/json'});
 await page.screenshot({path:testInfo.outputPath('synthetic-legacy-'+testInfo.project.name+'.png'),fullPage:true});
});
