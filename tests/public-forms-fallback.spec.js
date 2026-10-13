import { test, expect } from '@playwright/test';
for(const route of ['submit','contact']){
  test(`unconfigured ${route} form does not load a widget or send data`,async({page})=>{
    const external=[];page.on('request',request=>{if(request.url().includes('challenges.cloudflare.com')||request.method()==='POST')external.push(request.url());});
    await page.goto(`./#${route}`);
    await expect(page.getByText('Online sending is not available yet.',{exact:true})).toBeVisible();
    await expect(page.locator('#send-submission')).toBeDisabled();
    await expect(page.getByText('Nothing you send here is published automatically.',{exact:false})).toBeVisible();
    await expect(page.getByRole('link',{name:'Email the newsroom instead'})).toHaveAttribute('href','mailto:info@churchtimesnigeria.net');
    expect(external).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  });
}
