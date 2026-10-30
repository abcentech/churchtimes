import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const open=async page=>{await page.goto('/fixture.html');await page.waitForFunction(()=>window.scriptureReady===true);};
const refs=page=>page.locator('.ct-scripture-ref');

test('wraps only valid references in prose, never in headings, links or code',async({page})=>{
  await open(page);
  await expect(refs(page)).toHaveText(['John 3:16','Psalm 23','1 Cor. 13:4–7','Matthew 5:3-12']);
  await expect(page.locator('h2 .ct-scripture-ref, a .ct-scripture-ref, code .ct-scripture-ref')).toHaveCount(0);
  await expect(page.locator('#p1')).toContainText('Mark 2 times.');
  expect(await page.locator('article').textContent()).toBe(await page.evaluate(()=>window.originalText));
});

test('click opens a labelled KJV card; Escape closes it and returns focus',async({page})=>{
  await open(page);
  const button=refs(page).first();
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded','true');
  const card=page.locator(`#${await button.getAttribute('aria-controls')}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('For God so loved the world');
  await expect(card).toContainText('KJV');
  await expect(card).toContainText('King James Version (public domain)');
  await expect(card).toHaveAttribute('role','dialog');
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded','false');
  await expect(button).toBeFocused();
});

test('keyboard: focus shows the card, Tab reaches its close button, which closes it',async({page})=>{
  await open(page);
  await refs(page).nth(1).focus();
  const card=page.locator('.ct-scripture-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('The LORD is my shepherd');
  await expect(card.locator('.ct-scripture-verse')).toHaveCount(6);
  await page.keyboard.press('Tab');
  await expect(page.locator('.ct-scripture-close').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card).toBeHidden();
  await expect(refs(page).nth(1)).toBeFocused();
  await refs(page).nth(2).focus();
  await expect(page.locator('.ct-scripture-card:visible')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ct-scripture-card:visible')).toHaveCount(0);
  await expect(refs(page).nth(2)).toBeFocused();
});

test('hover shows the card, it stays while the pointer moves onto it, and hides after leaving',async({page,isMobile})=>{
  test.skip(isMobile,'hover needs a pointer');
  await open(page);
  const button=refs(page).nth(2);
  await button.hover();
  const card=page.locator(`#${await button.getAttribute('aria-controls')}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Charity suffereth long');
  await card.hover();
  await page.waitForTimeout(400);
  await expect(card).toBeVisible();
  await page.mouse.move(5,5);
  await expect(card).toBeHidden();
});

test('long passages are capped with an ellipsis and the card stays inside the viewport',async({page})=>{
  await open(page);
  const button=refs(page).nth(3);
  await button.click();
  const card=page.locator(`#${await button.getAttribute('aria-controls')}`);
  await expect(card.locator('.ct-scripture-verse')).toHaveCount(6);
  await expect(card.locator('.ct-scripture-more')).toHaveText('…');
  const box=await card.boundingBox(),width=page.viewportSize().width;
  expect(box.x).toBeGreaterThanOrEqual(15);
  expect(box.x+box.width).toBeLessThanOrEqual(width-15);
});

test('offline or missing text shows a plain message, not a broken card',async({page})=>{
  await page.route('**/public/scripture/kjv/*.json',route=>route.abort());
  await open(page);
  await refs(page).first().click();
  await expect(page.locator('.ct-scripture-card').first()).toContainText('could not be loaded');
  await expect(page.locator('#verse')).toBeHidden();
});

test('verse of the day renders the Easter verse with season and version labels',async({page})=>{
  await open(page);
  const verse=page.locator('#verse');
  await expect(verse).toBeVisible();
  await expect(verse).toContainText('Verse of the day');
  await expect(verse).toContainText('Easter Day');
  await expect(verse).toContainText('He is not here: for he is risen');
  await expect(verse.locator('cite')).toHaveText('Matthew 28:6');
  await expect(verse).toContainText('King James Version (public domain)');
});

test('dispose restores the original text exactly',async({page})=>{
  await open(page);
  await refs(page).first().click();
  await page.evaluate(()=>window.disposeRefs());
  await expect(refs(page)).toHaveCount(0);
  await expect(page.locator('.ct-scripture-card')).toHaveCount(0);
  expect(await page.locator('article').textContent()).toBe(await page.evaluate(()=>window.originalText));
});

test('axe: no violations with a card open',async({page})=>{
  await open(page);
  await refs(page).first().click();
  await expect(page.locator('.ct-scripture-card').first()).toContainText('For God so loved');
  const results=await new AxeBuilder({page}).include('main').analyze();
  expect(results.violations).toEqual([]);
});
