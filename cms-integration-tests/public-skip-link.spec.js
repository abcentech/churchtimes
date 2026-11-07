import {test,expect} from '@playwright/test';
const cms=process.env.PUBLIC_CMS_TEST_URL,ssr=process.env.PUBLIC_SSR_TEST_URL;
test('keyboard skip stays on a clean article and focuses its main content',async({page,request})=>{
 const fixture=await (await request.get(cms+'/__test/fixtures')).json();const path='/reports/'+fixture.publishedSlug+'/';
 await page.goto(ssr+path);await expect(page.locator('#cms-report .article-header h1')).toBeVisible();
 await page.locator('.skip-link').focus();await page.keyboard.press('Enter');await expect(page.getByRole('main')).toBeFocused();expect(new URL(page.url()).pathname).toBe(path);await expect(page.locator('#cms-report .article-header h1')).toContainText(fixture.runId);
 const html=await (await request.get(ssr+path)).text();expect(html).toContain('class="skip-link" href="'+path+'#main"');expect(html).toContain('<main id="main" tabindex="-1"');
});
