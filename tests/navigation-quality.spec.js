import {test,expect} from '@playwright/test';
test('duplicate history/hash notifications preserve an edited search form and its submission',async({page})=>{
 await page.goto('/#search/faith');const input=page.getByRole('searchbox',{name:'Search stories',exact:true});await expect(input).toBeVisible();
 await input.fill('synthetic-unmatched-query-6728');
 await page.evaluate(()=>{window.dispatchEvent(new PopStateEvent('popstate'));window.dispatchEvent(new HashChangeEvent('hashchange'));});
 await expect(input).toHaveValue('synthetic-unmatched-query-6728');
 await page.locator('#page-search').getByRole('button',{name:'Search',exact:true}).click();
 await expect(page.getByRole('heading',{name:'No matching stories.'})).toBeVisible();
 await page.goBack();await expect(input).toHaveValue('faith');
});
