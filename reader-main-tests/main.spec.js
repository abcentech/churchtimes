// Synthetic CMS and GA4 STUB fixtures: no real endpoint, measurement or reader data.
import {test,expect} from '@playwright/test';
const article=(slug,title)=>({id:slug.length,status:'published',slug,title,excerpt:'Synthetic excerpt.',publishedAt:'2026-10-16T12:00:00Z',category:{title:'News'},corrections:[],content:{root:{type:'root',children:[{type:'paragraph',children:[{type:'text',text:'Synthetic body text.'}]}]}}});
const stubArticles=(page,known)=>page.route('**/api/articles?**',route=>{
  const slug=new URL(route.request().url()).searchParams.get('where[slug][equals]');
  return route.fulfill({json:{docs:known[slug]?[known[slug]]:[],hasNextPage:false}});
});

test('a client-side link to a slug the CMS lacks falls back to the server redirect map',async({page})=>{
  await stubArticles(page,{'new-story':article('new-story','Renamed story landed')});
  const documents=[];
  await page.route('**/reports/renamed-story/',route=>{documents.push(route.request().resourceType());return route.fulfill({status:301,headers:{Location:'/reports/new-story/'}});});
  await page.goto('/');
  await page.evaluate(()=>{const a=document.createElement('a');a.id='old-link';a.href='/reports/renamed-story/';a.textContent='Old link';document.querySelector('#main').prepend(a);});
  await page.locator('#old-link').click();
  await expect(page).toHaveURL(/\/reports\/new-story\/$/);
  await expect(page.getByRole('heading',{level:1,name:'Renamed story landed'})).toBeVisible();
  expect(documents).toContain('document');
  await expect(page.getByText('Article unavailable.')).toHaveCount(0);
});

test('the server-rendered article stays visible while the lazy article chunk is stalled',async({page})=>{
  const slug='server-story';
  await stubArticles(page,{[slug]:article(slug,'Server story')});
  await page.route('**/reports/server-story/',async route=>{
    const response=await route.fetch();
    const json=JSON.stringify({...article(slug,'Server story'),category:'News',bylineName:'',featuredImage:null}).replace(/</g,'\\u003c');
    const html=(await response.text()).replace('</head>',()=>`<script id="public-article" type="application/json">${json}</script></head>`).replace('<div id="app"></div>','<div id="app"><main id="main" class="container section-list newsroom-report"><article><h1>Server story</h1><p>Server rendered body.</p></article></main></div>');
    return route.fulfill({response,body:html});
  });
  let release;const gate=new Promise(resolve=>{release=resolve;});let stalled;const seen=new Promise(resolve=>{stalled=resolve;});
  await page.route('**/lib/article-content.js**',async route=>{stalled();await gate;return route.continue();});
  await page.goto('/reports/server-story/',{waitUntil:'domcontentloaded'});
  await seen;
  await expect(page.locator('#app main article h1')).toHaveText('Server story');
  await expect(page.getByText('Loading article…')).toHaveCount(0);
  await expect(page.locator('#cms-report')).toHaveCount(0);
  release();
  await expect(page.locator('#cms-report article h1')).toHaveText('Server story');
  await expect(page.locator('#cms-report')).toContainText('Synthetic body text.');
});

async function pageViews(page){return page.evaluate(()=>(window.dataLayer||[]).map(item=>Array.from(item)).filter(item=>item[0]==='event'&&item[1]==='page_view').map(item=>item[2]));}
async function withAnalytics(page){
  await page.route('https://www.googletagmanager.com/**',route=>route.fulfill({contentType:'text/javascript',body:'/* STUB GA4 transport */'}));
  await page.addInitScript(()=>localStorage.setItem('ct-optional-consent-v1',JSON.stringify({analytics:true,forms:false,push:false})));
}
test('analytics reports a fixed title and no query for search, and the route for hash pages',async({page})=>{
  await withAnalytics(page);
  await page.route('**/api/public/search?**',route=>route.fulfill({json:{docs:[],totalDocs:0,totalCapped:false,hasNextPage:false}}));
  await page.goto('/#search/very%20private%20query');
  await expect.poll(()=>pageViews(page)).toHaveLength(1);
  const [view]=await pageViews(page);
  expect(view.page_title).toBe('Search — Church Times Nigeria');
  expect(view.page_location).toBe('http://127.0.0.1:6398/#search');
  expect(JSON.stringify(view)).not.toContain('private');
  await page.evaluate(()=>{location.hash='section/news';});
  await expect.poll(async()=>(await pageViews(page)).at(-1)?.page_location).toBe('http://127.0.0.1:6398/#section/news');
});
test('analytics reports an async article page only once the title is final',async({page})=>{
  await withAnalytics(page);
  await stubArticles(page,{'late-story':article('late-story','Late story')});
  await page.goto('/reports/late-story/');
  await expect(page.locator('#cms-report article h1')).toHaveText('Late story');
  await expect.poll(()=>pageViews(page)).toHaveLength(1);
  const [view]=await pageViews(page);
  expect(view.page_title).toBe('Late story — Church Times Nigeria');
  expect(view.page_location).toBe('http://127.0.0.1:6398/reports/late-story/');
});

test('public search uses the C8 endpoint, shows capped counts and honours Retry-After',async({page})=>{
  const urls=[];let limited=true;
  await page.route('**/api/public/search?**',route=>{
    urls.push(new URL(route.request().url()));
    if(limited){limited=false;return route.fulfill({status:429,headers:{'Retry-After':'9'},json:{ok:false}});}
    return route.fulfill({json:{docs:[{id:1,slug:'faith-and-service',title:'Faith and service',excerpt:'x',snippet:'Matching snippet',publishedAt:'2026-10-13T08:00:00Z',category:{id:1,slug:'news',title:'News'},categories:[],rank:1}],totalDocs:1000,totalCapped:true,hasNextPage:false}});
  });
  await page.goto('/#search/faith');
  await expect(page.locator('#cms-search')).toContainText('wait 9s before');
  await page.locator('#cms-search').getByRole('button',{name:'Try again'}).click();
  await expect(page.locator('#cms-search')).toContainText('Faith and service');
  await expect(page.locator('#cms-search')).toContainText('Over 1,000 matches');
  expect(urls.every(u=>u.pathname==='/api/public/search'&&u.searchParams.get('q')==='faith')).toBe(true);
});
