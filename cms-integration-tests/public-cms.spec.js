import { test, expect } from '@playwright/test';
const cms=process.env.PUBLIC_CMS_TEST_URL || 'http://127.0.0.1:3201';
const widget=async page=>page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',route=>route.fulfill({contentType:'application/javascript',body:`
window.turnstile={render(container,options){window.__challenge=options;const b=document.createElement('button');b.type='button';b.textContent='Complete test verification';b.onclick=()=>options.callback('public-integration-valid');container.append(b);return 'cms-test';},reset(){},remove(){}};
`}));
async function fill(page,data){
  await page.getByLabel('Your name').fill('CMS integration reader');
  await page.getByLabel('Email address').fill(data.email);
  await page.getByLabel('Phone number (required)',{exact:true}).fill('+234 803 123 4567');
  await page.getByLabel('Headline or story subject').fill(data.title);
  await page.getByLabel('Location (optional)',{exact:true}).fill('Lagos');
  await page.getByLabel('Section (required)',{exact:true}).selectOption('News');
  await page.getByLabel('Your story or tip').fill(data.body);
  await page.getByLabel('I agree that the newsroom').check();
}
const send=page=>page.getByRole('button',{name:'Submit for editorial review',exact:true});
test('real published API shows populated media, byline, correction and no draft/staff fields',async({page,request})=>{
  const fixture=await (await request.get(cms+'/__test/fixtures')).json();
  const response=await request.get(cms+'/api/articles?limit=100&depth=1');expect(response.status()).toBe(200);
  const docs=(await response.json()).docs;expect(docs.every(doc=>doc.status==='published')).toBe(true);
  expect(docs.some(doc=>doc.slug===fixture.draftSlug)).toBe(false);
  for(const doc of docs){expect(doc.author).toBeUndefined();expect(doc.reviewNotes).toBeUndefined();expect(doc.scheduledFor).toBeUndefined();}
  await page.goto('/#report/'+fixture.publishedSlug);
  await expect(page.locator('.article-header')).toContainText('CMS integration byline');
  await expect(page.locator('.article-corrections')).toContainText('A verified fixture correction.');
  const image=page.locator('.newsroom-figure img');await expect(image).toHaveJSProperty('complete',true);
  expect(await image.evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);
  await expect(image).toHaveAttribute('src',new RegExp('^'+cms.replaceAll('.','\\.')+'/api/media/file/'));
  await page.goto('/#report/'+fixture.draftSlug);
  await expect(page.getByRole('heading',{name:'Article unavailable.'})).toBeVisible();
});

test('real submission remains new, editor converts/reviews/publishes, then Vite can read it',async({page,request},testInfo)=>{
  const fixture=await (await request.get(cms+'/__test/fixtures')).json();
  const data={email:`${fixture.runId}-${testInfo.project.name}@test.invalid`,title:`${fixture.runId}-public-${testInfo.project.name}`,body:'A genuine local integration test exercising Payload, PostgreSQL and the public Vite form.'};
  await widget(page);await page.goto('/#submit');await fill(page,data);
  await page.getByRole('button',{name:'Complete test verification',exact:true}).click();
  expect(await page.evaluate(()=>window.__challenge.action)).toBe('submit-story');
  await send(page).click();
  await expect(page.getByRole('heading',{name:'Your story is awaiting review.'})).toBeVisible();
  const receipt=(await page.locator('#form-result').innerText()).match(/Reference: (SUB-[A-Z0-9]+)/)[1];
  const saved=await (await request.get(cms+'/__test/submission?reference='+receipt)).json();
  expect(saved.status).toBe('new');expect(saved.phone).toBe('+234 803 123 4567');expect(saved.categorySuggestion).toBe('News');expect(saved.location).toBe('Lagos');
  const before=await (await request.get(cms+'/api/articles?where[title][equals]='+encodeURIComponent(data.title))).json();expect(before.docs).toHaveLength(0);
  const workflow=await (await request.post(cms+'/__test/publish',{data:{reference:receipt}})).json();
  expect(workflow.reporterPublishStatus).toBe(403);expect(workflow.convertStatus).toBe(201);expect(workflow.anonymousBeforeStatus).toBe(404);
  expect(workflow.reviewStatus).toBe(200);expect(workflow.approveStatus).toBe(200);expect(workflow.publishStatus).toBe(200);
  await page.goto('/#report/'+workflow.slug);
  await expect(page.locator('h1')).toHaveText(data.title);
  await expect(page.locator('.newsroom-article-body')).toContainText(data.body);
  await expect(page.locator('.article-header')).toContainText('Integration editor');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.goto('/#submit');await fill(page,data);await page.getByRole('button',{name:'Complete test verification',exact:true}).click();await send(page).click();
  await expect(page.locator('#form-errors')).toContainText('already received a matching submission');
  await expect(page.locator('#form-result')).toBeHidden();
});

test('real rejected/spent Turnstile response cannot show success and preserves the message',async({page,request},testInfo)=>{
  const fixture=await (await request.get(cms+'/__test/fixtures')).json();
  await widget(page);await page.goto('/#submit');await fill(page,{email:`${fixture.runId}-bad-${testInfo.project.name}@test.invalid`,title:fixture.runId+'-rejected-token',body:'This local submission must be rejected by the real server verification path.'});
  await page.getByRole('button',{name:'Complete test verification',exact:true}).click();
  await page.evaluate(()=>window.__challenge.callback('spent-token'));
  await send(page).click();await expect(page.locator('#form-errors')).toContainText('Verification was not accepted');
  await expect(page.locator('#form-result')).toBeHidden();await expect(page.locator('#public-message')).toHaveValue(/must be rejected/);
});

test('real category and search filters, clean URLs, reload and canonical lifecycle',async({page,request})=>{
  const f=await (await request.get(cms+'/__test/fixtures')).json();
  // The real Next proxy rejects the old slug-as-relationship-ID filter.
  expect((await request.get(cms+'/api/articles?where[category][equals]='+f.categorySlug)).status()).toBe(400);
  const categoryResponse=page.waitForResponse(r=>r.url().includes('/api/articles?')&&new URL(r.url()).searchParams.has('where[category][equals]'));
  await page.goto('/sections/'+f.categorySlug+'/');
  const filtered=await categoryResponse;expect(filtered.status()).toBe(200);
  expect(new URL(filtered.url()).searchParams.get('where[category][equals]')).toBe(String(f.categoryId));
  await expect(page.locator('.newsroom-card h2').filter({hasText:f.publishedTitle})).toHaveCount(1);
  await expect(page.locator(`a[href="/reports/${f.otherSlug}/"]`)).toHaveCount(0);
  await page.goto('/search/?q='+encodeURIComponent(f.publishedTitle));
  await expect(page.locator('.newsroom-card')).toHaveCount(1);
  await page.locator('.newsroom-card h2 a').click();
  await expect(page).toHaveURL(new RegExp('/reports/'+f.publishedSlug+'/$'));
  await expect(page.locator('h1')).toHaveText(f.publishedTitle);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href','http://127.0.0.1:5177/reports/'+f.publishedSlug+'/');
  const schema=await page.locator('script[type="application/ld+json"]').textContent();
  expect(JSON.parse(schema).mainEntityOfPage).toBe('http://127.0.0.1:5177/reports/'+f.publishedSlug+'/');
  await page.reload();await expect(page.locator('h1')).toHaveText(f.publishedTitle);
  await page.locator('.home-link').click();await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  await page.goBack();await expect(page.locator('h1')).toHaveText(f.publishedTitle);
  await page.goto('/reports/'+f.draftSlug+'/');
  await expect(page.getByRole('heading',{name:'Article unavailable.'})).toBeVisible();
  await expect(page.locator('link[rel="canonical"],script[type="application/ld+json"]')).toHaveCount(0);
  await page.goto('/search/?q=synthetic-no-match-987654');
  await expect(page.getByRole('heading',{name:'No matching published reports.'})).toBeVisible();
  await page.goto('/sections/unconfigured-category/');
  await expect(page.getByRole('heading',{name:'Section unavailable.'})).toBeVisible();
});

test('real sanitized validation and rate-limit responses retain text, enforce cooldown and fresh token',async({page,request},testInfo)=>{
  const f=await (await request.get(cms+'/__test/fixtures')).json();
  const data={email:`${f.runId}-limits-${testInfo.project.name}@test.invalid`,title:'<b></b>',body:'Synthetic validation and rate limit fixture; it contains no live personal data.'};
  await widget(page);await page.goto('/#submit');await fill(page,data);
  await page.getByRole('button',{name:'Complete test verification',exact:true}).click();
  let response=page.waitForResponse(r=>r.url()===cms+'/api/public/submissions'&&r.request().method()==='POST');
  await send(page).click();expect((await response).status()).toBe(400);
  await expect(page.locator('#form-errors')).toContainText('Please check this field');
  await expect(page.locator('#form-result')).toBeHidden();
  await expect(page.locator('#public-message')).toHaveValue(data.body);
  try {
    await request.post(cms+'/__test/controls',{data:{rateLimit:true}});
    await page.getByLabel('Headline or story subject').fill(f.runId+'-rate-first-'+testInfo.project.name);
    await page.getByRole('button',{name:'Complete test verification',exact:true}).click();
    response=page.waitForResponse(r=>r.url()===cms+'/api/public/submissions'&&r.request().method()==='POST');
    await send(page).click();expect((await response).status()).toBe(201);
    await expect(page.locator('#form-result')).toBeVisible();
    await page.reload();
    await fill(page,{...data,email:`${f.runId}-second-${testInfo.project.name}@test.invalid`,title:f.runId+'-rate-second-'+testInfo.project.name});
    await page.getByRole('button',{name:'Complete test verification',exact:true}).click();
    response=page.waitForResponse(r=>r.url()===cms+'/api/public/submissions'&&r.request().method()==='POST');
    await send(page).click();const limited=await response;expect(limited.status()).toBe(429);
    expect(Number(limited.headers()['retry-after'])).toBeGreaterThan(0);
    await expect(page.locator('#form-errors')).toContainText('Too many submissions');
    await expect(page.locator('#form-result')).toBeHidden();
    await expect(page.locator('#send-submission')).toBeDisabled();await expect(page.locator('#public-message')).toHaveValue(data.body);
    await expect(page.locator('#send-submission')).toBeEnabled({timeout:6000});
    await send(page).click();await expect(page.locator('#form-result')).toBeHidden();
    await page.getByRole('button',{name:'Complete test verification',exact:true}).click();
    await send(page).click();await expect(page.locator('#form-result')).toBeVisible();
  } finally {await request.post(cms+'/__test/controls',{data:{}});}
});

test('lost response after genuine persistence does not confirm or retry',async({page,request},testInfo)=>{
  const f=await (await request.get(cms+'/__test/fixtures')).json();
  const data={email:`${f.runId}-lost-${testInfo.project.name}@test.invalid`,title:f.runId+'-lost-'+testInfo.project.name,body:'Synthetic network-loss fixture saved by real Payload before its response is dropped.'};
  try {
    await request.post(cms+'/__test/controls',{data:{dropResponse:true}});
    await widget(page);await page.goto('/#submit');await fill(page,data);
    await page.getByRole('button',{name:'Complete test verification',exact:true}).click();
    let posts=0;page.on('request',r=>{if(r.url()===cms+'/api/public/submissions'&&r.method()==='POST')posts++;});
    await send(page).click();await expect(page.locator('#form-errors')).toContainText('could not confirm whether your submission was received');
    await expect(page.locator('#form-result')).toBeHidden();await expect(page.locator('#public-message')).toHaveValue(data.body);
    const state=await (await request.get(cms+'/__test/fixtures')).json();
    const saved=await request.get(cms+'/__test/submission?reference='+state.lastDroppedReference);
    expect(saved.status()).toBe(200);expect((await saved.json()).status).toBe('new');
    await send(page).click();expect(posts).toBe(1);await expect(page.locator('#form-result')).toBeHidden();
  } finally {await request.post(cms+'/__test/controls',{data:{}});}
});
