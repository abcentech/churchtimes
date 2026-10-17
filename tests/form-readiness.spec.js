import {test,expect} from '@playwright/test';
test('Submission inputs remain disabled while the lazy form binder loads',async({page})=>{
  let release;const ready=new Promise(resolve=>release=resolve);
  await page.route('**/src/forms/public-form.js',async route=>{await ready;await route.continue();});
  await page.goto('/#submit');
  await expect(page.getByRole('textbox',{name:'Your name'})).toBeDisabled();
  release();await expect(page.getByRole('textbox',{name:'Your name'})).toBeEnabled();
});
