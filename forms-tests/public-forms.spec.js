import { test, expect } from '@playwright/test';
const SCRIPT='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const widgetScript=`
window.__widgetResets=0;window.__widgetRemovals=0;
window.turnstile={
 render(container,options){
  window.__widgetOptions=options;
  const button=document.createElement('button');button.type='button';button.textContent='Complete test verification';
  button.onclick=()=>options.callback('test-token-'+window.__widgetResets);
  button.style.width=options.size==='compact'?'150px':'300px';
  container.replaceChildren(button);return 'test-widget';
 },
 reset(){window.__widgetResets++;},
 remove(){window.__widgetRemovals++;}
};`;
async function widget(page){ await page.route(SCRIPT,route=>route.fulfill({contentType:'application/javascript',body:widgetScript})); }
async function complete(page){ await page.getByRole('button',{name:'Complete test verification',exact:true}).click(); }
async function fill(page,kind='story'){
  await page.getByLabel('Your name').fill('A reader');
  await page.getByLabel('Email address').fill('reader@example.test');
  await page.getByLabel('Phone number (required)',{exact:true}).fill('+234 803 123 4567');
  await page.getByLabel(kind==='story'?'Headline or story subject':'Subject',{exact:false}).fill('A story from the community');
  if(kind==='story') await page.getByLabel('Section (required)',{exact:true}).selectOption('News');
  await page.getByLabel(kind==='story'?'Your story or tip':'Your message').fill('The key facts and source links for the newsroom.');
  await page.getByLabel('I agree that the newsroom').check();
}
const submit=page=>page.getByRole('button',{name:'Submit for editorial review',exact:true});
async function noOverflow(page){ expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy(); }

test('accessible field errors focus the summary and never call the API',async({page})=>{
  await widget(page);
  let calls=0;await page.route('**/api/public/submissions',route=>{calls++;return route.fulfill({status:201,json:{ok:true,reference:'MOCK-ONLY-RECEIPT',message:'Received. An editor will review your submission.'}});});
  await page.goto('/#submit');
  await submit(page).click();
  await expect(page.locator('#form-errors')).toBeFocused();
  await expect(page.locator('#form-errors li')).toHaveCount(8);
  await expect(page.getByLabel('Your name')).toHaveAttribute('aria-invalid','true');
  await page.locator('#form-errors').getByRole('link',{name:'Enter your name.',exact:true}).click();
  await expect(page.getByLabel('Your name')).toBeFocused();
  await fill(page);await complete(page);await page.getByLabel('Email address').fill('not-an-email');await submit(page).click();
  await expect(page.locator('#error-email')).toHaveText('Enter a valid email address so the newsroom can reply.');
  expect(calls).toBe(0);await noOverflow(page);
});

test('mocked success sends one anonymous request, clears text and promises review only',async({page})=>{
  await widget(page);
  let calls=0;let release;
  const pending=new Promise(resolve=>release=resolve);
  await page.route('**/api/public/submissions',async route=>{
    calls++;const body=route.request().postDataJSON();
    expect(body.turnstileToken).toBe('test-token-0');expect(body.body).toContain('key facts');
    expect(body.status).toBeUndefined();expect(body.categorySuggestion).toBe('News');expect(body.category).toBeUndefined();expect(body.website).toBe('');expect(body.consent).toBeUndefined();expect(route.request().headers().authorization).toBeUndefined();
    await pending;await route.fulfill({status:201,json:{ok:true,reference:'MOCK-ONLY-123',message:'Received. An editor will review your submission.'}});
  });
  await page.goto('/#submit');await fill(page);await complete(page);
  await submit(page).click();
  await expect(page.getByRole('button',{name:'Sending…',exact:true})).toBeDisabled();
  await expect(page.getByLabel('Your name')).toBeDisabled();
  await expect(page.locator('#public-message')).toBeDisabled();
  await page.locator('#public-form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(calls).toBe(1);release();
  await expect(page.getByRole('heading',{name:'Your story is awaiting review.'})).toBeVisible();
  await expect(page.locator('#form-result')).toContainText('It has not been published.');
  await expect(page.locator('#form-result')).toContainText('MOCK-ONLY-123');
  await expect(page.locator('#form-result')).toBeFocused();
  expect(await page.locator('#public-message').inputValue()).toBe('');
  expect(await page.evaluate(()=>Object.keys(localStorage).concat(Object.keys(sessionStorage)))).toEqual([]);
  await noOverflow(page);
});

test('expired verification blocks sending until a new token is obtained',async({page})=>{
  await widget(page);let calls=0;
  await page.route('**/api/public/submissions',route=>{calls++;return route.fulfill({status:201,json:{ok:true,reference:'MOCK-ONLY-RECEIPT',message:'Received. An editor will review your submission.'}});});
  await page.goto('/#submit');await fill(page);await complete(page);
  await page.evaluate(()=>window.__widgetOptions['expired-callback']());
  await expect(page.locator('#challenge-status')).toContainText('Verification expired');
  await submit(page).click();expect(calls).toBe(0);
  await page.getByRole('button',{name:'Restart verification'}).click();await complete(page);
  await submit(page).click();await expect(page.locator('#form-result')).toBeVisible();expect(calls).toBe(1);
});

test('rate limits respect Retry-After and require a fresh token',async({page})=>{
  await widget(page);await page.clock.install();let calls=0;
  await page.route('**/api/public/submissions',route=>{
    calls++;return calls===1?route.fulfill({status:429,headers:{'Retry-After':'2'},json:{}}):route.fulfill({status:201,json:{ok:true,reference:'MOCK-ONLY-RECEIPT',message:'Received. An editor will review your submission.'}});
  });
  await page.goto('/#submit');await fill(page);await complete(page);await submit(page).click();
  await expect(page.locator('#form-errors')).toContainText('Too many submissions');
  await expect(page.locator('#send-submission')).toBeDisabled();
  await expect(page.locator('#public-message')).toHaveValue('The key facts and source links for the newsroom.');
  await page.clock.runFor(2200);await expect(submit(page)).toBeEnabled();
  await submit(page).click();expect(calls).toBe(1);
  await complete(page);await submit(page).click();await expect(page.locator('#form-result')).toBeVisible();expect(calls).toBe(2);
});

test('network failure retains text and does not automatically retry',async({page})=>{
  await widget(page);let calls=0;
  await page.route('**/api/public/submissions',route=>{calls++;return route.abort('failed');});
  await page.goto('/#submit');await fill(page);await complete(page);await submit(page).click();
  await expect(page.locator('#form-errors')).toContainText('could not confirm whether your submission was received');
  await expect(page.locator('#public-message')).toHaveValue('The key facts and source links for the newsroom.');
  await expect(page.locator('#public-form')).toHaveAttribute('aria-busy','false');expect(calls).toBe(1);
  await submit(page).click();expect(calls).toBe(1);
});

test('backend field errors and rejected challenges are accessible and safe',async({page})=>{
  await widget(page);let calls=0;
  await page.route('**/api/public/submissions',route=>{
    calls++;return calls===1?route.fulfill({status:400,json:{ok:false,errors:[{field:'email',message:'<img src=x onerror=alert(1)>'}]}}):route.fulfill({status:403,json:{ok:false,errors:[{field:'turnstileToken',message:'Verification failed.'}]}});
  });
  await page.goto('/#submit');await fill(page);await complete(page);await submit(page).click();
  await expect(page.locator('#error-email')).toHaveText('Please check this field and try again.');
  await expect(page.getByLabel('Email address')).toHaveAttribute('aria-invalid','true');
  await complete(page);await submit(page).click();
  await expect(page.locator('#form-errors')).toContainText('Verification was not accepted');
  await expect(page.locator('#form-result')).toBeHidden();
  await expect(page.locator('#form-errors img')).toHaveCount(0);
});

test('HTTP success without an explicit receipt is never shown as received',async({page})=>{
  await widget(page);await page.route('**/api/public/submissions',route=>route.fulfill({json:{}}));
  await page.goto('/#submit');await fill(page);await complete(page);await submit(page).click();
  await expect(page.locator('#form-errors')).toContainText('did not confirm receipt');
  await expect(page.locator('#form-result')).toBeHidden();
});

test('widget script failures can be retried without bypassing verification',async({page})=>{
  let loads=0;await page.route(SCRIPT,route=>++loads===1?route.abort('failed'):route.fulfill({contentType:'application/javascript',body:widgetScript}));
  let calls=0;await page.route('**/api/public/submissions',route=>{calls++;return route.fulfill({status:201,json:{ok:true,reference:'MOCK-ONLY-RECEIPT',message:'Received. An editor will review your submission.'}});});
  await page.goto('/#submit');await fill(page);
  await expect(page.locator('#challenge-status')).toContainText('Verification could not load');
  await submit(page).click();expect(calls).toBe(0);
  await page.getByRole('button',{name:'Restart verification'}).click();await complete(page);
  await submit(page).click();await expect(page.locator('#form-result')).toBeVisible();expect(loads).toBe(2);
});

test('contact form uses its separate configured endpoint and subject/message fields',async({page})=>{
  await widget(page);
  await page.route('**/api/public/contact',route=>{
    const body=route.request().postDataJSON();expect(body.subject).toBe('A story from the community');
    expect(body.message).toContain('key facts');expect(body.title).toBeUndefined();expect(body.body).toBeUndefined();
    return route.fulfill({status:201,json:{ok:true,reference:'MOCK-ONLY-CONTACT',message:'Received. An editor will review your submission.'}});
  });
  await page.goto('/#contact');await fill(page,'contact');await complete(page);
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Your message has been received.'})).toBeVisible();
  await noOverflow(page);
});

test('navigation removes widgets and releases form data without storage',async({page})=>{
  await widget(page);await page.goto('/#submit');await fill(page);await complete(page);
  await page.locator('.home-link').click();
  await expect(page.locator('.lead-story h1')).toBeVisible();
  expect(await page.evaluate(()=>window.__widgetRemovals)).toBe(1);
  await page.goto('/#submit');
  await expect(page.getByLabel('Your name')).toHaveValue('');
  await expect(page.locator('#public-message')).toHaveValue('');
  expect(await page.evaluate(()=>Object.keys(localStorage).concat(Object.keys(sessionStorage)))).toEqual([]);
});

test('narrow screens use compact verification and resizing discards the old token',async({page})=>{
  await widget(page);let calls=0;
  await page.route('**/api/public/submissions',route=>{calls++;return route.fulfill({status:201,json:{ok:true,reference:'MOCK-ONLY-RECEIPT',message:'Received. An editor will review your submission.'}});});
  await page.setViewportSize({width:320,height:800});await page.goto('/#submit');await fill(page);await complete(page);
  expect(await page.evaluate(()=>window.__widgetOptions.size)).toBe('compact');await noOverflow(page);
  await page.setViewportSize({width:800,height:900});
  await expect.poll(()=>page.evaluate(()=>window.__widgetOptions.size)).toBe('flexible');
  await submit(page).click();expect(calls).toBe(0);
  await complete(page);await submit(page).click();await expect(page.locator('#form-result')).toBeVisible();
});

test('late widget load after navigation does not mount into a detached page',async({page})=>{
  let release;
  const gate=new Promise(resolve=>release=resolve);
  await page.route(SCRIPT,async route=>{await gate;await route.fulfill({contentType:'application/javascript',body:widgetScript});});
  await page.goto('/#submit',{waitUntil:'domcontentloaded'});await expect(page.locator('#challenge-status')).toContainText('Loading');
  await page.locator('.home-link').click();release();
  await expect(page.locator('.lead-story h1')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>Boolean(window.turnstile))).toBe(true);
  expect(await page.evaluate(()=>window.__widgetOptions)).toBeUndefined();
});

for (const kind of ['story','contact']) {
  test(`${kind} form requires, validates and sends a phone number`,async({page})=>{
    await widget(page);
    let calls=0;
    await page.route(kind==='story'?'**/api/public/submissions':'**/api/public/contact',route=>{
      calls++;expect(route.request().postDataJSON().phone).toBe('+234 803 123 4567');
      return route.fulfill({status:201,json:{ok:true,reference:'MOCK-ONLY-RECEIPT',message:'Received. An editor will review your submission.'}});
    });
    await page.goto(kind==='story'?'/#submit':'/#contact');await fill(page,kind);await complete(page);
    const phone=page.getByLabel('Phone number (required)',{exact:true});
    await expect(phone).toHaveAttribute('type','tel');
    await expect(phone).toHaveAttribute('autocomplete','tel');
    await expect(phone).toHaveAttribute('required','');
    await phone.fill('');await page.locator('#send-submission').click();
    await expect(page.locator('#error-phone')).toHaveText('Enter a phone number so the newsroom can contact you.');
    expect(calls).toBe(0);
    await phone.fill('not a phone');
    await page.locator('#send-submission').click();
    await expect(phone).toHaveAttribute('aria-invalid','true');
    await expect(page.locator('#error-phone')).toContainText('7–15 digits');
    await expect(page.locator('#form-errors')).toBeFocused();
    await page.locator('#form-errors a').click();await expect(phone).toBeFocused();
    expect(calls).toBe(0);
    await phone.fill('+234 803 123 4567');await page.locator('#send-submission').click();
    await expect(page.locator('#form-result')).toBeVisible();expect(calls).toBe(1);
    await expect(phone).toHaveValue('');
  });
}

test('mocked CMS-contract success maps location/categorySuggestion and uses only the returned reference',async({page})=>{
 await widget(page);let calls=0;
 await page.route('**/api/public/submissions',route=>{
  calls++;const data=route.request().postDataJSON();expect(data.categorySuggestion).toBe('News');expect(data.location).toBe('Lagos');expect(data.website).toBe('');expect(data.category).toBeUndefined();expect(data.consent).toBeUndefined();
  return route.fulfill({status:201,json:{ok:true,reference:'SUB-ABCDEFGH',message:'Received. An editor will review your submission.'}});
 });
 await page.goto('/#submit');await fill(page);await page.getByLabel('Location (optional)').fill('Lagos');await complete(page);await submit(page).click();
 await expect(page.locator('#form-result')).toContainText('SUB-ABCDEFGH');await expect(page.locator('#form-result')).toContainText('It has not been published.');expect(calls).toBe(1);
});
test('CMS error arrays focus mapped fields and duplicate replies preserve text without false receipts',async({page})=>{
 await widget(page);let calls=0;
 await page.route('**/api/public/submissions',route=>{calls++;return calls===1?route.fulfill({status:400,json:{ok:false,errors:[{field:'body',message:'PRIVATE SERVER MESSAGE'}]}}):route.fulfill({status:409,json:{ok:false,errors:[{message:'We already received this submission.'}]}});});
 await page.goto('/#submit');await fill(page);await complete(page);await submit(page).click();
 await expect(page.locator('#public-message')).toHaveAttribute('aria-invalid','true');await expect(page.locator('#form-errors')).not.toContainText('PRIVATE SERVER MESSAGE');
 await complete(page);await submit(page).click();
 await expect(page.locator('#form-errors')).toContainText('already received');await expect(page.locator('#public-message')).toHaveValue('The key facts and source links for the newsroom.');await expect(page.locator('#form-result')).toBeHidden();expect(calls).toBe(2);
});
test('CMS minimum story length prevents invalid sending before verification is consumed',async({page})=>{
 await widget(page);let calls=0;await page.route('**/api/public/submissions',route=>{calls++;return route.fulfill({json:{ok:true,reference:'SHOULD-NOT-SEND'}});});
 await page.goto('/#submit');await fill(page);await page.getByLabel('Your story or tip').fill('Too short.');await complete(page);await submit(page).click();
 await expect(page.locator('#error-message')).toContainText('at least 30 characters');expect(calls).toBe(0);
});

test('gateway 401 and incomplete 201 receipts never confirm or discard the draft',async({page})=>{
  await widget(page);let calls=0;
  await page.route('**/api/public/submissions',route=>route.fulfill(++calls===1?{status:401,json:{ok:false}}:{status:201,json:{ok:true,reference:'MISSING-MESSAGE'}}));
  await page.goto('/#submit');await fill(page);await complete(page);await submit(page).click();
  await expect(page.locator('#form-result')).toBeHidden();await expect(page.locator('#form-errors')).toBeVisible();
  await expect(page.locator('#public-message')).toHaveValue('The key facts and source links for the newsroom.');
  await complete(page);await submit(page).click();await expect(page.locator('#form-errors')).toContainText('did not confirm receipt');
  await expect(page.locator('#form-result')).toBeHidden();expect(calls).toBe(2);
});
