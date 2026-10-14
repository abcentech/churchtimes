import {test,expect} from '@playwright/test';
const record={id:1,slug:'new-report',status:'published',title:'A newly published report',excerpt:'Public reporting',bylineName:'Public writer',category:{id:12,slug:'news',title:'News'},content:'A public body'};
test('category and search failures preserve the static edition and permit a retry',async({page})=>{
 await page.route('**/api/categories?**',route=>route.fulfill({json:{docs:[{id:12,slug:'news',title:'News'}]}}));
 let fail=true;await page.route('**/api/articles?**',route=>fail?route.fulfill({status:403,json:{errors:[{message:'PRIVATE'}]}}):route.fulfill({json:{docs:[record]}}));
 await page.goto('/#search/Faith');await expect(page.locator('#cms-search')).toContainText('Public reporting is unavailable');await expect(page.locator('#cms-search')).not.toContainText('PRIVATE');
 fail=false;await page.locator('#cms-search').getByRole('button',{name:'Try again'}).click();await expect(page.locator('#cms-search h2 a')).toHaveText(record.title);
 await page.locator('#cms-search h2 a').click();await expect(page).toHaveURL(/\/reports\/new-report\/$/);await expect(page.locator('h1')).toHaveText(record.title);
 await page.getByRole('link',{name:'Church Times Nigeria home',exact:true}).first().click();await expect(page).toHaveURL(/\/#home$/);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('unknown CMS categories never get passed as relationship IDs or substitute another section',async({page})=>{
 let calls=0;await page.route('**/api/articles?**',route=>{calls++;return route.fulfill({json:{docs:[record]}});});
 await page.route('**/api/categories?**',route=>route.fulfill({json:{docs:[]}}));await page.goto('/#category/missing');await expect(page.locator('#cms-latest')).toContainText('Section unavailable.');expect(calls).toBe(0);
});
