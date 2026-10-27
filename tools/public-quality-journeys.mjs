import {chromium,devices,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function checkPublicJourneys({origin,fixture,output,chromePath,cmsUrl}) {
  const browser=await chromium.launch({executablePath:chromePath,args:['--no-sandbox','--disable-dev-shm-usage']});
  const results=[];
  try {
    for(const [device,settings] of [['desktop',{viewport:{width:1440,height:1000}}],['mobile',devices['Pixel 7']]]) {
      const context=await browser.newContext(settings);
      for(const [name,path] of [['home','/'],['latest','/#latest'],['article','/reports/'+fixture.publishedSlug+'/'],['live','/#live']]) {
        const page=await context.newPage(),faults=[];
        const allowed=new Set([new URL(origin).origin,new URL(cmsUrl).origin]);
        page.on('request',request=>{if(!allowed.has(new URL(request.url()).origin))faults.push('unexpected-origin');});
        page.on('pageerror',()=>faults.push('pageerror'));
        page.on('console',message=>{if(message.type()==='error')faults.push('consoleerror');});
        const row={page:name,device,passed:false};
        let check='navigation';
        try {
          const response=await page.goto(origin+path);expect(response.status()).toBe(200);expect(response.headers()['x-robots-tag']).toContain('noindex');
          check='CMS content';
          if(name==='home')await expect(page.locator('#newsroom-home')).toContainText(fixture.runId);
          if(name==='latest')await expect(page.locator('#newsroom-grid')).toContainText(fixture.runId);
          if(name==='article')await expect(page.locator('#cms-report .article-header h1')).toContainText(fixture.runId);
          if(name==='live')await expect(page.locator('.live-event-links')).toContainText(fixture.liveTitle);
          await page.evaluate(()=>document.fonts.ready);
          check='landmarks and layout';
          await expect(page.getByRole('main')).toHaveCount(1);await expect(page.locator('h1')).toHaveCount(1);
          expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
          expect(await page.locator('img:not([alt])').count()).toBe(0);
          check='WCAG';
          const wcag=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();expect(wcag.violations).toEqual([]);
          check='visible labels and heading order';
          const labels=await new AxeBuilder({page}).withRules(['label-content-name-mismatch','heading-order']).analyze();expect(labels.violations).toEqual([]);
          check='skip navigation and focus';
          await page.locator('.skip-link').focus();await page.keyboard.press('Enter');await expect(page.getByRole('main')).toBeFocused();
          check='console and page errors';
          expect(faults).toEqual([]);row.passed=true;
        } catch {row.passed=false;row.failedCheck=check;console.error('Public browser gate failed: '+device+'/'+name+' ('+check+')');} finally {results.push(row);await page.close();}
      }
      await context.close();
    }
  } finally {await browser.close();await writeFile(join(output,'journeys.json'),JSON.stringify(results,null,2)+'\n');}
  return results;
}
