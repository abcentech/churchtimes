import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
// Explicit STUB contract harness: no CMS, SMTP or real Cloudflare verification is tested.
async function setup(page,{status=202,body={ok:true},retry='3'}={}) {
  const requests=[];let scripts=0;
  await page.route('https://challenges.cloudflare.com/**',route=>{scripts++;return route.fulfill({contentType:'application/javascript',body:`window.stubResets=0;window.turnstile={render(el,options){window.stubAction=options.action;window.stubCallback=options.callback;options.callback('synthetic-single-use-token');return 'widget';},reset(){window.stubResets++;window.stubCallback?.('synthetic-fresh-token');},remove(){}};`});});
  await page.route('**/api/public/**',route=>{requests.push({url:route.request().url(),method:route.request().method(),body:route.request().postDataJSON()});return route.fulfill({status,headers:{'Content-Type':'application/json','Retry-After':retry},body:JSON.stringify(body)});});
  return {requests,scripts:()=>scripts};
}
async function fill(page,kind='newsletter') {
  await page.getByLabel('Name',{exact:false}).fill('Synthetic Reader');await page.getByLabel('Email address').fill('reader@example.test');
  if(kind==='newsletter')await page.getByRole('checkbox').check();else await page.getByLabel('Message (20 to 5,000 characters)').fill('Synthetic message for the contact contract stub.');
  await page.getByRole('button',{name:'Allow spam protection'}).click();await expect(page.getByText('Verification complete.',{exact:true})).toBeVisible();
}
for(const kind of ['newsletter','contact']) {
  test(`${kind}: explicit permission gates Turnstile and correct contract action/payload (STUB)`,async({page})=>{
    const errors=[];page.on('pageerror',e=>errors.push(e.message));const stub=await setup(page,{status:kind==='newsletter'?202:201,body:kind==='newsletter'?{ok:true,message:'untrusted backend text'}:{ok:true,reference:'MSG-7KQ2M9XA'}});
    await page.goto(`/reader-forms-tests/harness.html?kind=${kind}`);await expect(page.getByRole('button',{name:'Allow spam protection'})).toBeVisible();expect(stub.scripts()).toBe(0);expect(stub.requests).toHaveLength(0);
    await fill(page,kind);expect(stub.scripts()).toBe(1);expect(await page.evaluate(()=>window.stubAction)).toBe(kind==='newsletter'?'newsletter-subscribe':'contact-message');
    const accessibility=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','best-practice']).analyze();expect(accessibility.violations).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.getByRole('button',{name:kind==='newsletter'?'Sign up':'Send message',exact:true}).click();
    await expect(page.locator('[data-reader-status]')).toContainText(kind==='newsletter'?'If this address can be subscribed, we sent a confirmation email.':'MSG-7KQ2M9XA');
    expect(stub.requests).toHaveLength(1);expect(stub.requests[0].method).toBe('POST');expect(stub.requests[0].body.turnstileToken).toBe('synthetic-single-use-token');expect(stub.requests[0].body.phone).toBeUndefined();expect(stub.requests[0].body.subject).toBeUndefined();expect(errors).toEqual([]);
  });
  for(const [status,text] of [[400,'Please check the form'],[403,'cannot accept requests'],[409,'matching message'],[413,'too large'],[415,'Online sending is unavailable'],[429,'Try again in 86400 seconds'],[503,kind==='newsletter'?'Sign-up is unavailable':'Online sending is unavailable'],[500,'temporarily unavailable']]) {
    test(`${kind}: handles ${status} without false success (STUB)`,async({page})=>{
      const stub=await setup(page,{status,body:{ok:false,errors:[{field:'email',message:'<script>untrusted</script>'}]},retry:'9999999999'});
      await page.goto(`/reader-forms-tests/harness.html?kind=${kind}`);await fill(page,kind);await page.getByRole('button',{name:kind==='newsletter'?'Sign up':'Send message',exact:true}).click();
      await expect(page.locator('[data-reader-status]')).toContainText(text);await expect(page.getByLabel('Email address')).toHaveValue('reader@example.test');expect(stub.requests).toHaveLength(1);await expect(page.locator('[data-reader-errors] script')).toHaveCount(0);
      if(status===429)await expect(page.getByRole('button',{name:/Try again in/})).toBeDisabled();
    });
  }
}
for(const action of ['confirm','unsubscribe'])for(const status of [200,400])test(`${action} is explicit POST only, ${status} (STUB)`,async({page})=>{
  const stub=await setup(page,{status,body:{ok:status===200}});await page.goto(`/reader-forms-tests/harness.html?kind=${action}`);await expect(page.getByRole('button',{name:action==='confirm'?'Confirm subscription':'Unsubscribe',exact:true})).toBeVisible();
  await page.waitForTimeout(150);expect(stub.requests).toHaveLength(0);expect(stub.scripts()).toBe(0);expect(await page.locator('body').innerHTML()).not.toContain('synthetic-token');
  await page.getByRole('button',{name:action==='confirm'?'Confirm subscription':'Unsubscribe',exact:true}).click();await expect(page.locator('[data-reader-status]')).toContainText(status===400?'no longer valid':action==='confirm'?'subscription is confirmed':'unsubscribed');expect(stub.requests).toHaveLength(1);expect(stub.requests[0].body).toEqual({token:'synthetic-token'});expect(stub.requests[0].method).toBe('POST');
});
test('unset configuration hides signup, revocation removes challenge and blocks send (STUB)',async({page})=>{
  const stub=await setup(page);await page.goto('/reader-forms-tests/harness.html?disabled=1');await expect(page.locator('[data-reader-form]')).toHaveCount(0);expect(stub.scripts()).toBe(0);
  await page.goto('/reader-forms-tests/harness.html');await fill(page);await page.evaluate(()=>window.revokeFormsConsent());await page.getByRole('button',{name:'Sign up',exact:true}).click();await expect(page.locator('[data-reader-errors]')).toContainText('Allow spam protection');expect(stub.requests).toHaveLength(0);
});
for(const kind of ['newsletter','contact'])test(`${kind}: rejected Turnstile 403 resets challenge and retains input (STUB)`,async({page})=>{
  const stub=await setup(page,{status:403,body:{ok:false,errors:[{field:'turnstileToken',message:'Expired or spent'}]}});
  await page.goto(`/reader-forms-tests/harness.html?kind=${kind}`);await fill(page,kind);await page.getByRole('button',{name:kind==='newsletter'?'Sign up':'Send message',exact:true}).click();
  await expect(page.locator('[data-reader-status]')).toContainText('Complete a new spam-protection challenge');
  await expect(page.getByLabel('Email address')).toHaveValue('reader@example.test');await expect(page.getByText('Verification complete.',{exact:true})).toBeVisible();expect(stub.requests).toHaveLength(1);expect(await page.evaluate(()=>window.stubResets)).toBe(1);
});
