import { test, expect } from '@playwright/test';
const text = value => ({type:'text',text:value,format:0});
const article = {
  id:101,slug:'faith-in-public-life',title:'Faith in public life: a new community initiative',
  status:'published',excerpt:'Local churches are supporting education and community care.',
  category:{title:'News'},publishedAt:'2026-10-13T08:00:00Z',
  content:{root:{type:'root',children:[
    {type:'paragraph',children:[text('The initiative brings communities together across Lagos.')]},
    {type:'heading',tag:'h2',children:[text('A shared responsibility')]},
    {type:'paragraph',children:[text('Organisers described their plans for the coming year.')]},
  ]}},
};
async function mock(page, handler) {
  await page.route('**/api/articles?**',async route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('where[status][equals]')).toBe('published');
    await handler(route,url);
  });
}
const send = (route,docs,extra={}) => route.fulfill({json:{docs,...extra}});
async function noOverflow(page) {
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await expect(page.locator('main')).toHaveCount(1);
}

test('homepage exposes published reports without replacing the current edition',async({page})=>{
  await mock(page,route=>send(route,[article,{...article,status:'draft',title:'Private draft'}]));
  await page.goto('/');
  await expect(page.locator('.lead-story h1')).toBeVisible();
  await expect(page.locator('#newsroom-home')).toBeVisible();
  await expect(page.locator('#newsroom-home h2 a')).toHaveText(article.title);
  await expect(page.locator('#newsroom-home')).not.toContainText('Private draft');
  await page.locator('#newsroom-home h2 a').click();
  await expect(page.locator('h1')).toHaveText(article.title);
  await expect(page.locator('.newsroom-article-body')).toContainText('The initiative brings communities together');
  await expect(page).toHaveTitle(`${article.title} — Church Times Nigeria`);
  await noOverflow(page);
});

test('feed paginates, deduplicates, filters unpublished articles and recovers from failures',async({page})=>{
  let fail=true;
  await mock(page,(route,url)=>{
    if(url.searchParams.get('page')==='2') {
      if(fail) {fail=false;return route.fulfill({status:503,body:'Unavailable'});}
      return send(route,[article,{...article,id:102,slug:'second-report',title:'Second published report'}]);
    }
    return send(route,[article,{...article,status:'approved',title:'Not public yet'}],{hasNextPage:true,nextPage:2});
  });
  await page.goto('/#latest');
  await expect(page.locator('.newsroom-card')).toHaveCount(1);
  await page.getByRole('button',{name:'More reports',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('More reports could not be loaded');
  await expect(page.locator('.newsroom-card')).toHaveCount(1);
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.locator('.newsroom-card')).toHaveCount(2);
  await expect(page.locator('main')).not.toContainText('Not public yet');
  await noOverflow(page);
});

test('feed handles empty results and retryable initial outages',async({page})=>{
  let fail=true;
  await mock(page,route=>fail ? route.fulfill({status:503,body:'Unavailable'}) : send(route,[]));
  await page.goto('/#latest');
  await expect(page.getByRole('heading',{name:'We couldn’t reach the newsroom.'})).toBeVisible();
  fail=false;
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.getByRole('heading',{name:'More stories are on their way.'})).toBeVisible();
  await expect(page.locator('#cms-latest')).toHaveAttribute('aria-busy','false');
});

test('unpublished direct URLs never render content',async({page})=>{
  await mock(page,route=>send(route,[{...article,status:'draft',title:'Private draft',content:'Secret draft text'}]));
  await page.goto('/#report/faith-in-public-life');
  await expect(page.getByRole('heading',{name:'Article unavailable.'})).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Secret draft text');
});

test('unsafe content and long headlines remain safe and fit mobile screens',async({page})=>{
  const malicious={...article,title:'A'.repeat(240),excerpt:'<img src=x onerror="window.compromised=true">',publishedAt:'invalid',content:{root:{type:'root',children:[
    {type:'paragraph',children:[text('<script>window.compromised=true</script>'),{type:'link',fields:{url:'javascript:window.compromised=true'},children:[text('unsafe link')]}]},
    {type:'html',html:'<img src=x onerror="window.compromised=true">'},
  ]}}};
  await mock(page,route=>send(route,[malicious]));
  await page.goto('/#report/faith-in-public-life');
  await expect(page.locator('h1')).toHaveText(malicious.title);
  await expect(page.locator('.newsroom-article-body')).toContainText('<script>');
  await expect(page.locator('main script, main img, main a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(()=>window.compromised)).toBeUndefined();
  await noOverflow(page);
});

test('navigation away from a loading feed ignores its stale response',async({page})=>{
  let release;
  const waiting=new Promise(resolve=>release=resolve);
  await mock(page,async route=>{await waiting;await send(route,[article]);});
  await page.goto('/#latest');
  await expect(page.getByRole('status')).toHaveText('Loading published reports…');
  await page.locator('.home-link').click();
  release();
  await expect(page.locator('.lead-story h1')).toBeVisible();
  await expect(page.locator('#cms-latest')).toHaveCount(0);
});

test('reading list and newsroom navigation are reachable on mobile',async({page,isMobile})=>{
  await mock(page,route=>send(route,[article]));
  await page.goto('/#latest');
  if(isMobile){
    await page.getByRole('button',{name:'Open sections menu'}).click();
    await page.locator('#menu-dialog').getByRole('link',{name:'Your reading list'}).click();
    await expect(page.locator('h1')).toHaveText('Worth returning to.');
  } else await expect(page.locator('.desktop-nav a[href="#latest"]')).toHaveAttribute('aria-current','page');
  await expect(page.locator('.reading-link')).toBeVisible();
  await noOverflow(page);
});
