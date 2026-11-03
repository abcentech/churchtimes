import {test,expect} from '@playwright/test';

// STUB transport: the fixtures are synthetic; the real-CMS suite covers the actual API.
const categories=[{id:1,slug:'news',title:'News'},{id:2,slug:'health',title:'Health'},{id:3,slug:'education',title:'Education'},{id:4,slug:'business',title:'Business'},{id:5,slug:'columnists',title:'Columnists'}];
const articles=Array.from({length:19},(_,i)=>({id:i+1,status:'published',slug:`synthetic-${i+1}`,title:`Published story ${i+1}`,excerpt:'Synthetic public excerpt',publishedAt:new Date(Date.UTC(2026,9,30,12,0)-i*60000).toISOString(),category:categories[i%categories.length],featuredImage:null,bylineName:'Synthetic reporter',contentType:i===0?'sponsored':'news'}));
articles.splice(1,0,{id:999,status:'draft',slug:'private-draft',title:'Private draft',excerpt:'Not public',publishedAt:'2026-10-30T12:00:00Z'});
async function stubCMS(page,{fail=false}={}) {
 const requests=[];
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());requests.push(url);
  if(fail)return route.fulfill({status:503,json:{error:'Synthetic CMS unavailable'}});
  if(url.pathname==='/api/categories') {
   const slug=url.searchParams.get('where[slug][equals]');return route.fulfill({json:{docs:slug?categories.filter(c=>c.slug===slug):categories,hasNextPage:false}});
  }
  if(url.pathname==='/api/articles') {
   const ids=[...url.searchParams].filter(([k])=>/\[category\]\[equals\]$/.test(k)).map(([,v])=>v);
   const slug=url.searchParams.get('where[slug][equals]');
   const docs=(ids.length?articles.filter(a=>ids.includes(String(a.category?.id))):articles).filter(a=>!slug||a.slug===slug);
   const limit=Number(url.searchParams.get('limit')||12),pageNum=Number(url.searchParams.get('page')||1),slice=docs.slice((pageNum-1)*limit,pageNum*limit);
   return route.fulfill({json:{docs:slice,hasNextPage:pageNum*limit<docs.length,nextPage:pageNum*limit<docs.length?pageNum+1:null}});
  }
  return route.fulfill({status:404,json:{}});
 });
 return requests;
}
async function unique(page) {const slugs=await page.locator('main article[data-story-slug]').evaluateAll(nodes=>nodes.map(n=>n.dataset.storySlug));expect(new Set(slugs).size).toBe(slugs.length);}

test('CMS lead, headlines and paged latest stories stay published, ordered and unique (STUB)',async({page})=>{
 const requests=await stubCMS(page);await page.goto('/');
 await expect(page.locator('.lead-story h1')).toHaveText('Published story 1');
 await expect(page.locator('.lead-story .eyebrow')).toContainText('Sponsored');
 await expect(page.locator('.rail-story')).toHaveCount(3);await expect(page.getByText('Private draft')).toHaveCount(0);
 await expect(page.locator('#latest-grid article')).toHaveCount(7);await unique(page);
 await page.getByRole('button',{name:'More stories',exact:true}).click();await expect(page.locator('#latest-grid article')).toHaveCount(15);await unique(page);
 await page.getByRole('button',{name:'Opinion',exact:true}).click();await expect(page.locator('#latest-grid article')).toHaveCount(3);await expect(page.locator('#latest-grid')).toContainText('Published story 5');await unique(page);
 const first=requests.find(u=>u.pathname==='/api/articles');expect(first.searchParams.get('where[status][equals]')).toBe('published');expect(first.searchParams.get('sort')).toBe('-publishedAt');expect(requests.some(u=>u.searchParams.get('page')==='2')).toBe(true);
 await expect(page.locator('.lead-story h1 a')).toHaveAttribute('href',/synthetic-1\/$/);
});

test('grouped section pages use all matching CMS categories and page their results (STUB)',async({page})=>{
 const requests=await stubCMS(page);await page.goto('/#section/health');
 await expect(page.locator('#cms-section article').first()).toBeVisible();await expect(page.locator('main')).not.toContainText('Private draft');
 const query=requests.find(u=>u.pathname==='/api/articles').searchParams;
 expect(query.get('where[and][0][or][0][category][equals]')).toBe('2');expect(query.get('where[and][0][or][2][category][equals]')).toBe('3');
 await unique(page);
});

test('a failed CMS falls back to the bundled edition on home, section and latest (STUB)',async({page})=>{
 await stubCMS(page,{fail:true});await page.goto('/');
 await expect(page.locator('.lead-story h1')).toBeVisible();await expect(page.getByRole('status').filter({hasText:'Showing the saved edition'})).toBeVisible();
 await page.goto('/#section/news');await expect(page.locator('main')).toContainText('Showing the saved edition');await expect(page.locator('main .story-card').first()).toBeVisible();
 await page.goto('/#latest');await expect(page.locator('#cms-latest')).toContainText('We couldn’t reach the newsroom');await expect(page.locator('#cms-latest .story-card').first()).toBeVisible();
});

test('a healthy empty CMS does not replace the page with bundled stories (STUB)',async({page})=>{
 await page.route('**/api/**',route=>route.fulfill({json:{docs:[],hasNextPage:false}}));await page.goto('/');
 await expect(page.getByRole('heading',{name:'Newsroom stories are on the way.'})).toBeVisible();await expect(page.locator('.lead-story')).toHaveCount(0);
});

test('a page of unusable article slugs does not hide the next page (STUB)',async({page})=>{
 await page.route('**/api/**',route=>{
  const url=new URL(route.request().url());
  if(url.pathname!=='/api/articles')return route.fulfill({json:{docs:[],hasNextPage:false}});
  const first=url.searchParams.get('page')==='1';
  return route.fulfill({json:first?{docs:[{...articles[0],slug:'bad slug'}],hasNextPage:true,nextPage:2}:{docs:[articles[2]],hasNextPage:false}});
 });
 await page.goto('/');await expect(page.locator('.lead-story h1')).toHaveText(articles[2].title);
});

test('following and verse features stay available without duplicating newly paged stories (STUB)',async({page})=>{
 await stubCMS(page);
 await page.addInitScript(()=>localStorage.setItem('ct-following',JSON.stringify([{kind:'topic',slug:'faith',name:'Faith'}])));
 await page.route('**/api/public/topics/faith*',route=>route.fulfill({json:{topic:{slug:'faith',name:'Faith',isPublic:true},articles:[articles[0],articles.find(a=>a.slug==='synthetic-15')]}}));
 await page.goto('/');await expect(page.locator('.lead-story h1')).toHaveText('Published story 1');
 const following=page.locator('#growth-following');await expect(following).toContainText('Published story 15',{timeout:12000});await expect(following.locator('[data-story-slug="synthetic-1"]')).toHaveCount(0);await unique(page);
 await page.getByRole('button',{name:'More stories',exact:true}).click();await expect(page.locator('#latest-grid')).toContainText('Published story 15');
 await expect(following).toContainText('already shown above');await unique(page);
 await expect(page.locator('#growth-verse')).toBeAttached();
});


test('CMS articles can be saved, restored, removed and show related published stories (STUB)',async({page})=>{
 await stubCMS(page);await page.goto('/');
 await expect(page.locator('.lead-story h1')).toHaveText('Published story 1');
 expect(await page.evaluate(()=>localStorage.getItem('ct-reading-list'))).toBeNull();
 await page.locator('.lead-story [data-cms-save]').click();
 await expect(page.locator('.lead-story [data-cms-save]')).toHaveAttribute('aria-pressed','true');
 await page.locator('.lead-story h1 a').click();
 await expect(page.locator('#cms-report h1')).toHaveText('Published story 1');
 await expect(page.locator('#cms-report [data-cms-save]').first()).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('#cms-report [data-related-reports]')).toContainText('Published story 6');
 await expect(page.locator('#cms-report [data-related-reports]')).not.toContainText('Private draft');
 await expect(page.locator('.original-callout')).toHaveCount(0);
 await page.locator('.reading-link').click();await expect(page.locator('#saved-grid')).toContainText('Published story 1');
 await page.reload();await expect(page.locator('#saved-grid')).toContainText('Published story 1');
 await page.locator('#saved-grid [data-cms-save]').click();await expect(page.locator('#saved-grid')).toContainText('A little room for good reading.');
});

test('the original-publication callout remains on bundled briefings (STUB)',async({page})=>{
 await stubCMS(page,{fail:true});await page.goto('/');await expect(page.getByText('Showing the saved edition.')).toBeVisible();
 await page.locator('.lead-story h1 a').click();await expect(page.locator('.original-callout')).toContainText('The full story');
});


test('runtime newsletter switch controls homepage and article signup with consent (CMS and Turnstile STUBS)',async({page})=>{
 await stubCMS(page);let enabled=false,thirdParty=0;const posts=[];
 await page.route('**/api/public/newsletter/settings',route=>route.fulfill({json:{enabled,siteKey:'1x00000000000000000000AA'}}));
 await page.route('**/api/public/newsletter/subscribe',route=>{posts.push(route.request().postDataJSON());return route.fulfill({status:202,json:{ok:true}});});
 await page.route('https://challenges.cloudflare.com/**',route=>{thirdParty++;return route.fulfill({contentType:'application/javascript',body:`window.turnstile={render(el,opt){opt.callback('synthetic-token');return 'test';},reset(){},remove(){}}`});});
 await page.goto('/');await expect(page.locator('.lead-story h1')).toBeVisible();
 await expect(page.locator('#connect a[href^="mailto:"]')).toBeVisible();await expect(page.locator('#connect [data-reader-form]')).toHaveCount(0);
 enabled=true;await page.goto('/#report/synthetic-1');
 const article=page.locator('#cms-report [data-reader-form="newsletter"]');await expect(article).toBeVisible();
 await expect(page.locator('#connect [data-reader-form="newsletter"]')).toBeVisible();expect(thirdParty).toBe(0);
 expect(await page.evaluate(()=>localStorage.length)).toBe(0);
 await article.getByLabel('Email address').fill('reader@example.test');await article.getByRole('checkbox').check();
 await article.getByRole('button',{name:'Allow spam protection'}).click();
 await page.getByLabel('Allow Cloudflare spam protection for online forms').check();await page.getByRole('button',{name:'Close privacy notice'}).click();
 await expect(article.getByText('Verification complete.')).toBeVisible();await article.getByRole('button',{name:'Sign up'}).click();
 await expect(article.locator('[data-reader-status]')).toContainText('may be sent when email is available');
 expect(posts).toHaveLength(1);expect(posts[0].source).toBe('article');expect(thirdParty).toBe(1);
 enabled=false;await page.goto('/');await expect(page.locator('#connect a[href^="mailto:"]')).toBeVisible();await expect(page.locator('#connect [data-reader-form]')).toHaveCount(0);
});


test('unsubscribe remains available while signup is disabled without a build endpoint (CMS STUB)',async({page})=>{
 await stubCMS(page);const posts=[];
 await page.route('**/api/public/newsletter/settings',route=>route.fulfill({json:{enabled:false,siteKey:null}}));
 await page.route('**/api/public/newsletter/unsubscribe',route=>{posts.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});});
 await page.goto('/newsletter/unsubscribe?token=synthetic-token');
 await expect(page.getByRole('button',{name:'Unsubscribe',exact:true})).toBeVisible();expect(posts).toHaveLength(0);
 await page.getByRole('button',{name:'Unsubscribe',exact:true}).click();
 await expect(page.locator('[data-reader-status]')).toHaveText('You have been unsubscribed.');expect(posts).toEqual([{token:'synthetic-token'}]);
});
