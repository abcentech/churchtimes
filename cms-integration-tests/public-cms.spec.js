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
  const permission=page.getByRole('button',{name:'Allow spam protection',exact:true});
  if(await permission.isVisible())await permission.click();
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
  const image=page.locator('.newsroom-figure img').first();await expect(image).toHaveJSProperty('complete',true);
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

test('real CMS category selection resolves a numeric relationship and search includes public bylines',async({page,request})=>{
 const fixture=await (await request.get(cms+'/__test/fixtures')).json();
 const response=await request.get(cms+'/api/articles?depth=1&where[slug][equals]='+fixture.publishedSlug);
 const article=(await response.json()).docs[0];expect(article.category.id).toBeTruthy();
 const requests=[];page.on('request',r=>{if(r.url().includes('/api/articles?'))requests.push(new URL(r.url()));});
 await page.goto('/#latest');await expect(page.locator('#cms-category')).toBeVisible();
 await page.locator('#cms-category').selectOption(article.category.slug);
 await expect(page.locator('#cms-latest')).toContainText(article.title);
 expect(requests.some(u=>u.searchParams.get('where[and][0][or][0][category][equals]')===String(article.category.id))).toBe(true);
 await page.goto('/#search/'+encodeURIComponent(article.bylineName));
 await expect(page.locator('#cms-search')).toContainText(article.title);
 expect(requests.some(u=>u.searchParams.get('where[or][2][bylineName][like]')===article.bylineName)).toBe(true);
 await page.goto('/#search/does-not-exist-'+fixture.runId);
 await expect(page.locator('#cms-search')).toContainText('No matching published reports.');
});

test('clean direct article URLs reload, preserve navigation and expose canonical metadata',async({page,request},testInfo)=>{
 const fixture=await (await request.get(cms+'/__test/fixtures')).json();
 await page.goto('/reports/'+fixture.publishedSlug+'/');
 await expect(page.locator('.article-header')).toContainText('CMS integration byline');
 await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href','https://staging-public.example.test/reports/'+fixture.publishedSlug+'/');
 await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content','article');
 if(process.env.CAPTURE_PUBLIC_STAGING==='1')await page.screenshot({path:`docs/public-staging/real-article-${testInfo.project.name}.png`,fullPage:true});
 await page.reload();await expect(page.locator('.article-header')).toContainText('CMS integration byline');
 await page.locator('.breadcrumbs').getByRole('link',{name:'Latest reports'}).click();await expect(page).toHaveURL(/\/#latest$/);
 await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
 await page.locator('#cms-latest h2 a').first().click();await expect(page).toHaveURL(/\/reports\/[^/]+\/$/);
});

test('compiled public host serves article body and metadata without JavaScript and proper unpublished HTTP status',async({browser,request},testInfo)=>{
 const fixture=await (await request.get(cms+'/__test/fixtures')).json();
 const ssr=process.env.PUBLIC_SSR_TEST_URL || 'http://127.0.0.1:5373';
 const context=await browser.newContext({...testInfo.project.use,javaScriptEnabled:false});const page=await context.newPage();
 try {
  const response=await page.goto(ssr+'/reports/'+fixture.publishedSlug+'/');expect(response.status()).toBe(200);
  await expect(page.locator('h1')).toHaveCount(1);await expect(page.locator('main')).toContainText('Published text from real Payload and PostgreSQL.');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href','https://staging-public.example.test/reports/'+fixture.publishedSlug+'/');
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content','article');
  expect(JSON.parse(await page.locator('#article-schema').textContent())['@type']).toBe('NewsArticle');
  if(process.env.CAPTURE_PUBLIC_STAGING==='1')await page.screenshot({path:`docs/public-staging/ssr-no-js-${testInfo.project.name}.png`,fullPage:true});
  const missing=await page.goto(ssr+'/reports/'+fixture.draftSlug+'/');expect(missing.status()).toBe(404);await expect(page.locator('h1')).toHaveText('Article unavailable.');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{await context.close();}
});

test('real CMS rejects missing token and disallowed Origin without a fabricated receipt',async({page,request},testInfo)=>{
 const fixture=await (await request.get(cms+'/__test/fixtures')).json();
 await widget(page);await page.goto('/#submit');await fill(page,{email:fixture.runId+'-missing-'+testInfo.project.name+'@test.invalid',title:fixture.runId+'-missing-token',body:'This synthetic story exercises genuine server rejection and safe field errors.'});
 await page.getByRole('button',{name:'Complete test verification',exact:true}).click();
 await page.route('**/api/public/submissions',route=>{const data=route.request().postDataJSON();data.turnstileToken='';return route.continue({postData:JSON.stringify(data)});});
 await send(page).click();await expect(page.locator('#form-errors')).toContainText('Verification was not accepted');await expect(page.locator('#form-result')).toBeHidden();
 await page.unroute('**/api/public/submissions');
 // The compiled host is intentionally omitted from the submission origin allowlist.
 // The real REST layer exposes its 403: the UI must show a safe failure.
 const ssr=process.env.PUBLIC_SSR_TEST_URL || 'http://127.0.0.1:5373';
 const denied=await request.post(cms+'/api/public/submissions',{headers:{Origin:ssr},data:{}});expect(denied.status()).toBe(403);
 await page.goto(ssr+'/#submit');await fill(page,{email:fixture.runId+'-origin-'+testInfo.project.name+'@test.invalid',title:fixture.runId+'-origin-denial',body:'This synthetic story exercises genuine origin rejection and safe errors.'});
 await page.getByRole('button',{name:'Complete test verification',exact:true}).click();await send(page).click();
 await expect(page.locator('#form-errors')).toContainText('cannot accept submissions');await expect(page.locator('#form-result')).toBeHidden();await expect(page.locator('#public-message')).toHaveValue(/synthetic story/);

});


test('reserved localhost CMS URL enables real anonymous submissions without an endpoint override',async({page,request},testInfo)=>{
 const fixture=await (await request.get(cms+'/__test/fixtures')).json();
 await widget(page);await page.goto((process.env.PUBLIC_ALIAS_TEST_URL || 'http://127.0.0.1:5179')+'/#submit');
 await expect(send(page)).toBeEnabled();
 await fill(page,{email:fixture.runId+'-alias-'+testInfo.project.name+'@test.invalid',title:fixture.runId+'-alias-story',body:'This synthetic submission verifies the reserved localhost CMS origin without an override.'});
 await page.getByRole('button',{name:'Complete test verification',exact:true}).click();
 const response=page.waitForResponse(r=>r.url().includes('cms.churchtimes.localhost') && r.request().method()==='POST');await send(page).click();expect((await response).status()).toBe(201);
 await expect(page.getByRole('heading',{name:'Your story is awaiting review.'})).toBeVisible();
 if(process.env.CAPTURE_PUBLIC_STAGING==='1')await page.screenshot({path:`docs/public-staging/localhost-receipt-${testInfo.project.name}.png`,fullPage:true});
});
