import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('brand link name matches its visible label and public forms load only on demand',async({page})=>{
 const bindings=[];page.on('request',request=>{if(new URL(request.url()).pathname==='/src/forms/public-form.js')bindings.push(request.url());});
 await page.goto('/');await expect(page.locator('.lead-story h1')).toBeVisible();
 const result=await new AxeBuilder({page}).withRules(['label-content-name-mismatch']).analyze();expect(result.violations).toEqual([]);
 expect(bindings).toHaveLength(0);
 await page.goto('/#contact');await expect(page.locator('#public-form')).toBeVisible();await expect(page.locator('#public-form')).toHaveJSProperty('inert',false);expect(bindings).toHaveLength(1);
 await expect(page.getByRole('link',{name:'Church Times Nigeria home',exact:true}).first()).toBeVisible();
});
