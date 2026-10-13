import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { configureAds, fixtureConfig } from './fixtures.js';
import edition from '../src/data/stories.json' with { type: 'json' };

for(const width of [320,360,390,430,768,1024,1440]) {
  test(`direct homepage and article placements fit ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});
    await configureAds(page);
    await page.goto('/');
    const billboard=page.locator('[data-ad-placement="homepage-billboard"]');
    await expect(billboard).toBeVisible();
    await billboard.scrollIntoViewIfNeeded();
    await expect(billboard.getByText('Advertisement',{exact:true})).toBeVisible();
    await expect(billboard.getByRole('link')).toHaveAttribute('rel','sponsored noopener noreferrer');
    expect(await billboard.getByRole('link').getAttribute('href')).toBe('https://example.org/campaign');
    const img=billboard.locator('img');
    await expect(img).toHaveJSProperty('complete',true);
    expect(await img.evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);
    expect(await img.evaluate(img=>img.currentSrc)).toContain(width<=760?'320-100':'970-250');
    const mobile=page.locator('[data-ad-placement="mobile-banner"]');
    if(width<=760)await expect(mobile).toBeVisible();else await expect(mobile).toBeHidden();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.goto(`/#story/${edition.stories[3].slug}`);
    const inline=page.locator('[data-ad-placement="article-inline"]');
    await expect(inline).toBeVisible();
    await inline.getByRole('link').focus();
    await expect(inline.getByRole('link')).toBeFocused();
    await expect(page.locator('.article-body')).toContainText(edition.stories[3].briefing[0]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}

test('direct campaigns pass axe and reserve their creative size before image delivery',async({page})=>{
  await configureAds(page);
  let release;
  const waiting=new Promise(resolve=>release=resolve);
  await page.route('**/ad-fixtures/*.svg',async route=>{await waiting;await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="970" height="250"><rect width="100%" height="100%" fill="#e9ece4"/></svg>'});});
  await page.goto('/',{waitUntil:'domcontentloaded'});
  const creative=page.locator('[data-ad-placement="homepage-billboard"] .advertising-creative');
  await creative.scrollIntoViewIfNeeded();
  const before=await creative.boundingBox();
  expect(before.height).toBeGreaterThan(50);
  release();
  await expect(creative.locator('img')).toHaveJSProperty('complete',true);
  const after=await creative.boundingBox();
  expect(Math.abs(before.height-after.height)).toBeLessThan(1);
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
  expect(axe.violations).toEqual([]);
});

test('unavailable campaigns collapse and never request Google scripts',async({page})=>{
  const requests=[];page.on('request',request=>requests.push(request.url()));
  await configureAds(page,{campaigns:[],adsense:{enabled:true,reviewed:false}});
  await page.goto('/');
  await expect(page.locator('.advertising-slot,template[data-ad-placement]')).toHaveCount(0);
  expect(requests.filter(url=>/ad-fixtures|googlesyndication|doubleclick|adsbygoogle/.test(url))).toEqual([]);
});

test('failed campaign images collapse rather than leave an empty advertising box',async({page})=>{
  await configureAds(page);
  let release;
  const waiting=new Promise(resolve=>release=resolve);
  await page.route('**/ad-fixtures/*.svg',async route=>{await waiting;await route.fulfill({status:404,body:'Unavailable'});});
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await page.locator('[data-ad-placement="homepage-billboard"]').scrollIntoViewIfNeeded();
  release();
  await expect(page.locator('[data-ad-placement="homepage-billboard"]')).toHaveCount(0);
});

test('reviewed filled fallback is optional, never requested, and loses to direct campaigns',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async config=>{
    const {createAdvertisingSlot}=await import('/src/lib/advertising.js');
    let calls=0;
    const provider={getFilledSlot(){calls++;const ins=document.createElement('ins');ins.className='adsbygoogle';ins.dataset.adStatus='filled';ins.textContent='Reviewed fallback fixture';return ins;}};
    const disabled=createAdvertisingSlot('homepage-billboard',{campaigns:[],adsense:{enabled:true,reviewed:false}},{reviewedAdSense:provider});
    const filled=createAdvertisingSlot('homepage-billboard',{campaigns:[],adsense:{enabled:true,reviewed:true}},{reviewedAdSense:provider});
    const beforeDirect=calls;
    const direct=createAdvertisingSlot('homepage-billboard',{...config,adsense:{enabled:true,reviewed:true}},{reviewedAdSense:provider});
    const unfilled=createAdvertisingSlot('homepage-billboard',{campaigns:[],adsense:{enabled:true,reviewed:true}},{reviewedAdSense:{getFilledSlot(){const ins=document.createElement('ins');ins.className='adsbygoogle';return ins;}}});
    return {disabled:disabled===null,filled:filled?.textContent.includes('Reviewed fallback fixture'),direct:!!direct?.querySelector('a'),directDidNotRequestFallback:calls===beforeDirect,unfilled:unfilled===null,scripts:document.querySelectorAll('script[src*="googlesyndication"],script[src*="adsbygoogle"]').length};
  },fixtureConfig);
  expect(result).toEqual({disabled:true,filled:true,direct:true,directDidNotRequestFallback:true,unfilled:true,scripts:0});
});
