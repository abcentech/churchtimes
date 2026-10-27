import {test,expect} from '@playwright/test';
test('Reader startup keeps later navigation focus on the newly rendered main',async({page})=>{
  await page.goto('/');
  await page.getByRole('link',{name:'Advertise',exact:true}).first().click();
  await expect(page.getByRole('heading',{name:'A considered audience. A meaningful conversation.'})).toBeVisible();
  await expect(page.locator('#main')).toBeFocused();
  await page.getByRole('link',{name:'Contact',exact:true}).first().click();
  await expect(page.locator('#public-form-title')).toBeVisible();
  await expect(page.locator('#main')).toBeFocused();
});
