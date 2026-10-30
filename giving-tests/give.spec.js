import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
// Explicit STUB contract harness: the CMS giving API, Turnstile and the Paystack checkout page are routed in the browser.
const REF='CTG-0123456789abcdef0123456789abcdef';
const SETTINGS={enabled:true,provider:'paystack',testMode:true,currencies:[{currency:'NGN',label:'Naira',presets:[200000,500000,1000000],minimumMinor:100000,maximumMinor:100000000},{currency:'USD',label:'US dollars',presets:[1000,2500],minimumMinor:500,maximumMinor:100000}],causes:[{key:'general',label:'Where it is needed most'},{key:'relief',label:'Relief reporting'}],thankYouNote:'Thank you.',bankTransferNote:'Bank: Example Bank <b>not html</b>'};
async function setup(page,{settings=SETTINGS,init={status:201,body:{ok:true,reference:REF,checkoutUrl:'http://127.0.0.1:6293/fake-checkout/abc'}},statuses=[{ok:true,reference:REF,status:'succeeded',amountMinor:500000,currency:'NGN',expired:false}],consent=true}={}) {
  const requests=[];let scripts=0;
  await page.addInitScript(c=>{if(c)localStorage.setItem('ct-optional-consent-v1',JSON.stringify({analytics:false,forms:true,push:false}));},consent);
  await page.route('https://challenges.cloudflare.com/**',route=>{scripts++;return route.fulfill({contentType:'application/javascript',body:`window.turnstile={render(el,o){window.stubAction=o.action;o.callback('synthetic-single-use-token');return 'w';},reset(){},remove(){}};`});});
  await page.route('**/api/public/giving/**',route=>{
    const url=new URL(route.request().url());requests.push({path:url.pathname,search:url.search,method:route.request().method(),body:route.request().postDataJSON?.()});
    if(url.pathname.endsWith('/settings'))return route.fulfill({json:settings});
    if(url.pathname.endsWith('/init'))return route.fulfill({status:init.status,json:init.body});
    if(url.pathname.endsWith('/status'))return route.fulfill({json:statuses.length>1?statuses.shift():statuses[0]});
    return route.fulfill({status:404,json:{ok:false}});
  });
  await page.route('**/fake-checkout/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fake checkout</title><h1>Fake Paystack checkout</h1>'}));
  return {requests,scripts:()=>scripts};
}

test('the form: presets in naira first, accessible, no horizontal scroll, sends integer minor units only (STUB)',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const stub=await setup(page);await page.goto('/giving-tests/harness.html');
  await expect(page.getByRole('heading',{level:1})).toHaveText('Keep independent reporting free to read.');
  await expect(page.getByText('Test mode.')).toBeVisible();
  await expect(page.getByRole('radio',{name:'₦5,000'})).toBeChecked();
  await expect(page.getByText('Bank: Example Bank <b>not html</b>')).toBeVisible();
  await expect(page.getByText('Verification complete.')).toBeVisible();
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa','best-practice']).analyze();expect(axe.violations).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.getByLabel('Email address (for your receipt)').fill('reader@example.test');
  await page.getByLabel('Name (optional)').fill('Ada');
  await page.getByRole('radio',{name:'Relief reporting'}).check();
  await page.getByRole('checkbox',{name:/I agree/}).check();
  await page.getByRole('button',{name:'Continue to secure payment'}).click();
  await expect(page).toHaveURL(/fake-checkout\/abc$/);
  const sent=stub.requests.find(r=>r.path.endsWith('/init'));
  expect(sent.body).toEqual({amountMinor:500000,currency:'NGN',cause:'relief',email:'reader@example.test',anonymous:false,consent:true,website:'',name:'Ada',turnstileToken:'synthetic-single-use-token'});
  expect(await page.evaluate(()=>window.stubAction)).toBeUndefined(); // new document: the checkout
  expect(errors).toEqual([]);
});

test('other amount, currency switch and anonymous: exact cents, no name sent (STUB)',async({page})=>{
  const stub=await setup(page);await page.goto('/giving-tests/harness.html');
  await page.getByLabel('Currency').selectOption('USD');
  await expect(page.getByRole('radio',{name:'$25'})).toBeChecked();
  await page.getByRole('radio',{name:'Other'}).check();
  await expect(page.getByLabel(/Other amount/)).toBeFocused();
  await page.getByLabel(/Other amount/).fill('19.99');
  await page.getByRole('checkbox',{name:/Give anonymously/}).check();
  await expect(page.getByLabel('Name (optional)')).toBeHidden();
  await page.getByLabel('Email address (for your receipt)').fill('reader@example.test');
  await page.getByRole('checkbox',{name:/I agree/}).check();
  await page.getByRole('button',{name:'Continue to secure payment'}).click();
  await expect(page).toHaveURL(/fake-checkout/);
  const body=stub.requests.find(r=>r.path.endsWith('/init')).body;
  expect(body).toMatchObject({amountMinor:1999,currency:'USD',anonymous:true});expect(body.name).toBeUndefined();
});

test('client checks: missing consent, bad amount and bad email are announced and nothing is sent (STUB)',async({page})=>{
  const stub=await setup(page);await page.goto('/giving-tests/harness.html');
  await page.getByRole('radio',{name:'Other'}).check();await page.getByLabel(/Other amount/).fill('5.001');
  await page.getByLabel('Email address (for your receipt)').fill('nope');
  await page.getByRole('button',{name:'Continue to secure payment'}).click();
  const summary=page.locator('[data-give-errors]');await expect(summary).toBeFocused();
  await expect(summary).toContainText('Enter an amount');await expect(summary).toContainText('valid email');await expect(summary).toContainText('agree');
  await expect(page.getByLabel('Email address (for your receipt)')).toHaveAttribute('aria-invalid','true');
  await page.getByLabel(/Other amount/).fill('50');
  await page.getByRole('button',{name:'Continue to secure payment'}).click();
  await expect(summary).toContainText('between ₦1,000 and ₦1,000,000');
  expect(stub.requests.filter(r=>r.path.endsWith('/init'))).toHaveLength(0);
});

for(const [status,body,text] of [[429,{ok:false,errors:[{message:'x'}]},'Too many attempts'],[502,{ok:false,errors:[{message:'x'}]},'Nothing was charged'],[404,{ok:false},'not available'],[403,{ok:false,errors:[{field:'turnstileToken',message:'x'}]},'spam-protection'],[201,{ok:true,reference:REF,checkoutUrl:'https://evil.example/pay'},'could not start']])
  test(`init ${status}${status===201?' with a foreign checkout URL':''}: clear message, stays on the page (STUB)`,async({page})=>{
    await setup(page,{init:{status,body}});await page.goto('/giving-tests/harness.html');
    await page.getByLabel('Email address (for your receipt)').fill('reader@example.test');await page.getByRole('checkbox',{name:/I agree/}).check();
    await page.getByRole('button',{name:'Continue to secure payment'}).click();
    await expect(page.locator('[data-give-status]')).toContainText(text);await expect(page).toHaveURL(/harness\.html/);
    await expect(page.getByLabel('Email address (for your receipt)')).toHaveValue('reader@example.test');
  });

test('without forms consent Turnstile never loads and the form explains why (STUB)',async({page})=>{
  const stub=await setup(page,{consent:false});await page.goto('/giving-tests/harness.html');
  await expect(page.getByRole('button',{name:'Allow spam protection'})).toBeVisible();
  await page.getByLabel('Email address (for your receipt)').fill('reader@example.test');await page.getByRole('checkbox',{name:/I agree/}).check();
  await page.getByRole('button',{name:'Continue to secure payment'}).click();
  await expect(page.locator('[data-give-errors]')).toContainText('Allow spam protection');
  expect(stub.scripts()).toBe(0);expect(stub.requests.filter(r=>r.path.endsWith('/init'))).toHaveLength(0);
});

test('giving off: a clear unavailable message and no form (STUB)',async({page})=>{
  await setup(page,{settings:{enabled:false}});await page.goto('/giving-tests/harness.html');
  await expect(page.getByRole('heading',{level:1})).toHaveText('Online giving is not available right now.');
  await expect(page.locator('form')).toHaveCount(0);
});

test('return page: polls the CMS until confirmed, then strips the reference from the URL (STUB)',async({page})=>{
  const pending={ok:true,reference:REF,status:'pending',amountMinor:500000,currency:'NGN',expired:false};
  const stub=await setup(page,{statuses:[pending,{...pending,status:'succeeded'}]});
  await page.goto(`/giving-tests/harness.html?thanks=1&trxref=${REF}&reference=${REF}`);
  await expect(page.getByRole('heading',{level:1})).toHaveText('Thank you. Your gift was received.',{timeout:10000});
  await expect(page.getByText(/₦5,000 — Your payment is confirmed/)).toBeVisible();
  await expect(page).not.toHaveURL(/reference=/);
  expect(stub.requests.filter(r=>r.path.endsWith('/status')).length).toBeGreaterThanOrEqual(2);
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa','best-practice']).analyze();expect(axe.violations).toEqual([]);
});

test('return page: failed and unknown references are explained; a forged reference is never requested (STUB)',async({page})=>{
  const stub=await setup(page,{statuses:[{ok:true,reference:REF,status:'failed',amountMinor:500000,currency:'NGN',expired:false}]});
  await page.goto(`/giving-tests/harness.html?thanks=1&reference=${REF}`);
  await expect(page.getByRole('heading',{level:1})).toHaveText('The payment did not go through.');
  await page.evaluate(()=>sessionStorage.clear());
  await page.goto('/giving-tests/harness.html?thanks=1&reference=%3Cscript%3E');
  await expect(page.getByRole('heading',{level:1})).toHaveText('We could not find your payment.');
  expect(stub.requests.filter(r=>r.path.endsWith('/status')&&r.search.includes('script'))).toHaveLength(0);
});

test('the ask: footer link and a note after the article once it renders; one settings request; nothing when off (STUB)',async({page})=>{
  const stub=await setup(page);await page.goto('/giving-tests/ask.html');
  await expect(page.locator('.site-footer a[data-give-link]')).toHaveText('Support our journalism');
  const aside=page.locator('article .share-bar + aside.give-ask');await expect(aside).toBeVisible();
  await expect(aside.getByRole('link',{name:'Give to Church Times'})).toHaveAttribute('href','give/');
  const axe=await new AxeBuilder({page}).include('.give-ask').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(axe.violations).toEqual([]);
  await page.reload();await expect(page.locator('aside.give-ask')).toBeVisible();
  expect(stub.requests.filter(r=>r.path.endsWith('/settings'))).toHaveLength(1); // cached for the tab
});
test('the ask stays away when giving is off (STUB)',async({page})=>{
  await setup(page,{settings:{enabled:false}});await page.goto('/giving-tests/ask.html');
  await expect(page.locator('article .article-body')).toBeVisible();await page.waitForTimeout(300);
  await expect(page.locator('.give-ask, [data-give-link]')).toHaveCount(0);
});
