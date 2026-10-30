// Synthetic CMS fixtures only (STUB): no real endpoint, person or reader data.
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {readFileSync} from 'node:fs';
test.setTimeout(120_000);
const AXE_TAGS=['wcag2a','wcag2aa','wcag21aa','wcag22aa'];
const photo=readFileSync(new URL('../public/news-media/28527.jpg',import.meta.url));
const media=(name,alt)=>({id:name.length,url:`/api/media/file/${name}.jpg`,mimeType:'image/jpeg',width:1200,height:800,alt,caption:''});
const profile={id:3,name:'Ada Okafor',slug:'ada-okafor',role:'Senior Correspondent',isPublic:true};
const paragraph=text=>({type:'paragraph',children:[{type:'text',text}]});
const body=Array.from({length:6},(_,i)=>paragraph(`Paragraph ${i+1}. `+'The synod met to agree a timetable for rebuilding damaged churches across the diocese. '.repeat(12)));
const article={id:7,status:'published',slug:'synod-report',title:'Synod agrees a rebuilding timetable',excerpt:'Bishops set dates for the work.',publishedAt:'2026-10-20T08:00:00Z',lastSubstantiveUpdate:'2026-10-22T10:00:00Z',category:{title:'News'},kicker:'Synod 2026',contentType:'analysis',bylineName:'Fallback byline',bylineAuthor:profile,keyPoints:[{text:'Work starts in January.'},{text:'Twelve parishes are affected.'}],corrections:[{note:'An earlier version misstated the number of parishes.',correctedAt:'2026-10-23T09:00:00Z'}],
  content:{root:{type:'root',children:[body[0],{type:'block',fields:{blockType:'pullQuote',quote:'We will rebuild every church that was lost.',attribution:'The Bishop of the diocese'}},body[1],{type:'block',fields:{blockType:'gallery',images:[{image:media('choir','The choir singing at dawn'),caption:'The choir at dawn'},{image:media('nave','The damaged nave'),caption:'The nave after the storm'},{image:media('roof','Workers on the roof'),caption:''}]}},...body.slice(2)]}}};
const trust={editorialStandards:{root:{type:'root',children:[{type:'heading',tag:'h2',children:[{type:'text',text:'Accuracy'}]},paragraph('We verify before we publish.')]}},ownershipFunding:null,ethicsCorrectionsPolicy:{root:{type:'root',children:[paragraph('We correct errors openly and promptly.')]}},contactEditors:'Write to the editors.'};
async function stubCMS(page,{trustPayload=trust,calls=[]}={}) {
  await page.route('**/api/media/file/**',route=>route.fulfill({contentType:'image/jpeg',body:photo}));
  await page.route('**/api/articles?**',route=>{const slug=new URL(route.request().url()).searchParams.get('where[slug][equals]');return route.fulfill({json:{docs:slug==='synod-report'?[article]:[],hasNextPage:false}});});
  await page.route('**/api/public/**',route=>{
    const url=new URL(route.request().url());calls.push(url.pathname+url.search);
    if(url.pathname==='/api/public/authors/ada-okafor')return route.fulfill({json:{author:{...profile,bio:'Reports on faith and public life.',avatar:{url:'/api/media/file/ada.jpg',thumbnailUrl:'/api/media/file/ada-400.jpg',alt:'Ada Okafor'},socials:[{kind:'x',url:'https://x.example.test/ada'}]},articles:[{...article,content:undefined}],page:1,totalDocs:1,hasNextPage:false}});
    if(url.pathname==='/api/public/site-trust')return trustPayload?route.fulfill({json:trustPayload}):route.fulfill({status:404,json:{ok:false,errors:[{message:'Not found'}]}});
    if(url.pathname==='/api/public/corrections')return route.fulfill({json:{docs:[{article:{...article,content:undefined},corrections:[{note:'An earlier version misstated the number of parishes.',correctedAt:'2026-10-23T09:00:00Z'}]}],page:1,hasNextPage:false}});
    return route.fulfill({status:404,json:{ok:false,errors:[{message:'Not found'}]}});
  });
  return calls;
}
const axe=async(page,label)=>{const result=await new AxeBuilder({page}).withTags(AXE_TAGS).analyze();expect(result.violations,label).toEqual([]);};

test('a CMS article shows its label, kicker, Updated stamp, reading time, key points, pull quote, gallery and author link',async({page})=>{
  await stubCMS(page);
  await page.goto('/reports/synod-report/');
  const report=page.locator('#cms-report');
  await expect(report.locator('h1')).toHaveText('Synod agrees a rebuilding timetable');
  await expect(report.locator('.reader-type')).toHaveText('Analysis');
  await expect(report.locator('.reader-kicker')).toHaveText('Synod 2026');
  await expect(report.locator('.reader-updated')).toHaveText('Updated 22 October 2026');
  await expect(report.locator('.reader-time')).toHaveText('5 min read');
  await expect(report.getByRole('region',{name:'What you need to know'}).getByRole('listitem')).toHaveText(['Work starts in January.','Twelve parishes are affected.']);
  await expect(report.locator('.reader-pullquote blockquote')).toHaveText('We will rebuild every church that was lost.');
  await expect(report.getByRole('region',{name:'Gallery: 3 photos'}).getByRole('img')).toHaveCount(3);
  await expect(report.getByRole('img',{name:'The damaged nave'})).toBeVisible();
  await expect(report.getByRole('link',{name:'Ada Okafor'})).toHaveAttribute('href','/author/ada-okafor/');
  await expect(report.locator('.newsroom-corrections')).toContainText('misstated the number of parishes');
  const schema=JSON.parse(await page.locator('#article-schema').textContent());
  expect(schema.dateModified).toBe('2026-10-22T10:00:00.000Z');
  expect(schema.author).toEqual({'@type':'Person',name:'Ada Okafor',url:'https://public.example.test/author/ada-okafor/'});
  for(const theme of ['light','dark']) {
    await page.evaluate(t=>{document.documentElement.dataset.theme=t;},theme);
    await axe(page,`article ${theme}`);
  }
});

test('article text size zooms the column and the reading progress bar follows the article',async({page})=>{
  await stubCMS(page);
  await page.addInitScript(()=>localStorage.setItem('ct-text','3'));
  await page.setViewportSize({width:1280,height:720});
  await page.goto('/reports/synod-report/');
  const body=page.locator('#cms-report .article-body');
  await expect(body).toBeVisible();
  expect(await body.evaluate(el=>getComputedStyle(el).zoom)).toBe('1.25');
  expect(await page.locator('#cms-report .reader-keypoints').evaluate(el=>getComputedStyle(el).zoom)).toBe('1.25');
  const progress=()=>page.locator('#cms-report article').evaluate(el=>new DOMMatrixReadOnly(getComputedStyle(el,'::before').transform).a);
  expect(await progress()).toBeLessThan(0.05);
  await page.evaluate(()=>{const el=document.querySelector('#cms-report article');scrollTo(0,el.getBoundingClientRect().top+scrollY+el.offsetHeight/2-innerHeight/2);});
  await expect.poll(progress).toBeGreaterThan(0.2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('author pages render the profile, socials and stories, and pass axe in both themes',async({page})=>{
  await stubCMS(page);
  await page.goto('/author/ada-okafor/');
  const main=page.locator('#reader-page');
  await expect(main.getByRole('heading',{level:1})).toHaveText('Ada Okafor');
  await expect(main.locator('.reader-role')).toHaveText('Senior Correspondent');
  await expect(main.getByRole('link',{name:'X'})).toHaveAttribute('rel','me noopener noreferrer');
  await expect(main.getByRole('link',{name:'Synod agrees a rebuilding timetable'})).toHaveAttribute('href','/reports/synod-report/');
  await expect(main.locator('.newsroom-card .eyebrow')).toHaveText('Analysis · News');
  await expect(page).toHaveTitle('Ada Okafor — Church Times Nigeria');
  expect(JSON.parse(await page.locator('#article-schema').textContent())['@graph'][0]['@type']).toBe('ProfilePage');
  for(const theme of ['light','dark']) {
    await page.evaluate(t=>{document.documentElement.dataset.theme=t;},theme);
    await axe(page,`author ${theme}`);
  }
});

test('a server-rendered author page is taken over without fetching it again',async({page})=>{
  const calls=await stubCMS(page);
  const data={key:'author',param:'ada-okafor',page:1,status:200,data:{author:{name:'Ada Okafor',slug:'ada-okafor',role:'Senior Correspondent',bio:'Server copy of the biography.',avatar:'',socials:[],articles:[],page:1,hasNextPage:false}}};
  await page.route('**/author/ada-okafor/',async route=>{
    const response=await route.fetch();
    const html=(await response.text()).replace('</head>',()=>`<script id="public-reader-page" type="application/json">${JSON.stringify(data)}</script></head>`).replace('<div id="app"></div>','<div id="app"><main id="main" class="container section-list reader-page"><h1>Ada Okafor</h1><p>Server copy of the biography.</p></main></div>');
    return route.fulfill({response,body:html});
  });
  await page.goto('/author/ada-okafor/');
  await expect(page.locator('#reader-page .reader-bio')).toHaveText('Server copy of the biography.');
  expect(calls.filter(call=>call.startsWith('/api/public/authors'))).toEqual([]);
});

test('trust pages show published policy, hide unpublished pages and always list corrections',async({page})=>{
  await stubCMS(page);
  await page.goto('/about/editorial-standards/');
  await expect(page.locator('#reader-page h1')).toHaveText('Editorial standards');
  await expect(page.locator('#reader-page')).toContainText('We verify before we publish.');
  await expect(page.locator('#reader-page .reader-trust-links a')).toHaveText(['Corrections']);
  await axe(page,'editorial standards');
  await page.goto('/about/ownership/');
  await expect(page.locator('#reader-page h1')).toHaveText('Page not published yet.');
  await page.goto('/corrections/');
  await expect(page.locator('#reader-page h1')).toHaveText('Corrections');
  await expect(page.locator('#reader-page')).toContainText('We correct errors openly and promptly.');
  await expect(page.locator('.reader-log li li')).toContainText('23 October 2026');
  await expect(page.locator('.reader-log').getByRole('link',{name:'Synod agrees a rebuilding timetable'})).toHaveAttribute('href','/reports/synod-report/');
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
  await axe(page,'corrections dark');
});

test('the corrections log still answers when the trust pages are unpublished',async({page})=>{
  await stubCMS(page,{trustPayload:null});
  await page.goto('/corrections/');
  await expect(page.locator('#reader-page h1')).toHaveText('Corrections');
  await expect(page.locator('.reader-log')).toContainText('misstated the number of parishes');
});

test('the demo briefing still links out to the original article',async({page})=>{
  await page.goto('/');
  await page.locator('#latest-grid .story-card h3 a').first().click();
  await expect(page.locator('.article-header .eyebrow')).toContainText('STORY BRIEFING');
  await expect(page.getByRole('link',{name:/Read the original article/})).toHaveAttribute('href',/^https:\/\//);
  await expect(page.locator('.reader-keypoints, .reader-time')).toHaveCount(0);
});

test('the article prints without navigation, ads, sharing or forms',async({page})=>{
  await stubCMS(page);
  await page.goto('/reports/synod-report/');
  await expect(page.locator('#cms-report .reader-keypoints')).toBeVisible();
  await page.emulateMedia({media:'print'});
  for(const selector of ['.nav-shell','.site-footer','.share-bar','.utility-bar'])for(const el of await page.locator(selector).all())await expect(el).toBeHidden();
  await expect(page.locator('#cms-report h1')).toBeVisible();
  await expect(page.locator('#cms-report .reader-keypoints')).toBeVisible();
  expect(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor)).toBe('rgb(255, 255, 255)');
});
