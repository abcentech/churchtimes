import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import edition from '../src/data/stories.json' with {type:'json'};
test.setTimeout(120_000);
const AXE_TAGS=['wcag2a','wcag2aa','wcag21aa','wcag22aa'];
const story=`./#story/${edition.stories[3].slug}`;

test('the head bootstrap applies a saved dark theme before any module script runs',async({page})=>{
  await page.addInitScript(()=>{try{localStorage.setItem('ct-theme','dark');localStorage.setItem('ct-text','3');}catch{}});
  // Block the app bundle: only the inline bootstrap can have set the attributes.
  await page.route(/\/src\/main\.js|\/assets\/index-[^/]*\.js/,route=>route.abort());
  await page.goto('./',{waitUntil:'domcontentloaded'});
  expect(await page.evaluate(()=>({...document.documentElement.dataset}))).toEqual({theme:'dark',text:'3'});
});

test('the device dark preference is followed until the reader chooses otherwise',async({page})=>{
  await page.emulateMedia({colorScheme:'dark'});
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  expect(await page.evaluate(()=>getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(17, 24, 25)');
  await page.emulateMedia({colorScheme:'light'});
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
});

test('display settings are keyboard operable, persist and restore focus',async({page})=>{
  await page.goto(story);
  const opener=page.getByRole('button',{name:'Display settings',exact:true});
  await opener.focus();await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog',{name:'Display settings'});
  await expect(dialog).toBeVisible();
  await expect(opener).toHaveAttribute('aria-expanded','true');
  await expect(dialog.getByRole('radio',{name:'Match device'}).first()).toBeFocused();
  await dialog.getByRole('radio',{name:'Dark'}).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await dialog.getByRole('radio',{name:'High'}).check();
  await expect(page.locator('html')).toHaveAttribute('data-contrast','more');
  await dialog.getByRole('radio',{name:'Largest'}).check();
  await expect(page.locator('html')).toHaveAttribute('data-text','4');
  expect(await page.locator('.article-body').evaluate(el=>getComputedStyle(el).zoom)).toBe('1.4');
  // Ads, forms and the original-article call-out inside the column keep their size.
  expect(await page.locator('.article-body .original-callout').evaluate(el=>Number(getComputedStyle(el).zoom))).toBeCloseTo(1/1.4,3);
  const scan=await new AxeBuilder({page}).include('#reader-settings').withTags(AXE_TAGS).analyze();
  expect(scan.violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(opener).toHaveAttribute('aria-expanded','false');
  await page.reload();
  expect(await page.evaluate(()=>({...document.documentElement.dataset}))).toEqual({theme:'dark',contrast:'more',text:'4'});
  await opener.click();
  await page.getByRole('dialog',{name:'Display settings'}).getByRole('radio',{name:'Match device'}).first().check();
  await page.getByRole('dialog',{name:'Display settings'}).getByRole('radio',{name:'Default'}).check();
  expect(await page.evaluate(()=>[localStorage.getItem('ct-theme'),localStorage.getItem('ct-text')])).toEqual([null,null]);
});

for(const [theme,contrast] of [['light',''],['dark',''],['light','more'],['dark','more']]) {
  test(`public pages have no WCAG AA violations in the ${theme}${contrast?' high-contrast':''} theme`,async({page})=>{
    await page.addInitScript(([t,c])=>{try{localStorage.setItem('ct-theme',t);if(c)localStorage.setItem('ct-contrast',c);}catch{}},[theme,contrast]);
    await page.emulateMedia({reducedMotion:'reduce'});
    for(const route of ['./','./#contact','./#search/faith','./#saved',story]) {
      await page.goto(route);
      await expect(page.locator('main h1').first()).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
      const result=await new AxeBuilder({page}).withTags(AXE_TAGS).analyze();
      expect(result.violations,route).toEqual([]);
    }
  });
}

test('the reading progress bar tracks the article column',async({page})=>{
  await page.setViewportSize({width:1200,height:700});
  await page.goto(story);
  const progress=()=>page.locator('.article-page').evaluate(el=>new DOMMatrixReadOnly(getComputedStyle(el,'::before').transform).a);
  expect(await progress()).toBeLessThan(0.05);
  await page.evaluate(()=>{const el=document.querySelector('.article-page');window.scrollTo(0,el.offsetTop+el.offsetHeight-innerHeight);});
  await expect.poll(progress).toBeGreaterThan(0.95);
  expect(await page.locator('.article-page').evaluate(el=>getComputedStyle(el,'::before').position)).toBe('fixed');
});
