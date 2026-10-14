import {test,expect} from '@playwright/test';
test('unconfigured public live coverage is reachable with an honest fallback and no CMS request',async({page})=>{
 const requests=[];page.on('request',request=>{if(request.url().includes('/api/live-'))requests.push(request.url());});
 await page.goto('./#live');await expect(page.locator('h1')).toHaveText('Live coverage.');await expect(page.locator('#live-discovery')).toContainText('Live coverage is not available yet');await expect(page.locator('#live-event')).toBeHidden();expect(requests).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
