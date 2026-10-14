import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';

const edition=JSON.parse(readFileSync(new URL('../src/data/stories.json',import.meta.url),'utf8'));
const lead=edition.stories.find(s=>s.id===29259);
const falobi=edition.stories.find(s=>s.id===29276);

test('home uses current headlines and locally served original photographs', async ({page})=>{
  await page.goto('./');
  await expect(page.locator('h1')).toHaveText(lead.title);
  await expect(page.locator('.rail-story').first()).toContainText(edition.stories.find(s=>s.id===29264).title);
  await expect(page.locator('.homepage-perspectives')).toContainText(falobi.title);
  await expect(page.locator('#latest-grid .story-card')).toHaveCount(6);
  const hero=page.locator('.lead-photo img');
  await expect(hero).toHaveJSProperty('complete',true);
  expect(await hero.evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);
  expect(await page.locator('body').innerText()).not.toContain('EDITORIAL CONCEPT');
  for(const story of edition.stories){
    expect(story.source.startsWith('https://churchtimesnigeria.net/')).toBeTruthy();
    expect(story.title.length).toBeGreaterThan(10);
    expect(existsSync(new URL('../public/'+story.image,import.meta.url))).toBeTruthy();
  }
});

test('filters and more-stories reveal real matching results', async ({page})=>{
  await page.goto('./');
  await page.getByRole('button',{name:'Business',exact:true}).click();
  await expect(page.locator('#latest-grid .story-card')).toHaveCount(2);
  await expect(page.locator('#latest-grid')).toContainText('ANLCA');
  await page.getByRole('button',{name:'Interviews',exact:true}).click();
  await expect(page.locator('#latest-grid .story-card')).toHaveCount(2);
  await expect(page.locator('#latest-grid')).toContainText('Olusada');
  await page.getByRole('button',{name:'All',exact:true}).click();
  await page.getByRole('button',{name:'More stories',exact:true}).click();
  await expect(page.locator('#latest-grid .story-card')).toHaveCount(12);
});

test('story briefing preserves byline, date and full-report destination', async ({page})=>{
  await page.goto('./#story/'+falobi.slug);
  await expect(page.locator('h1')).toHaveText(falobi.title);
  await expect(page.locator('.article-meta')).toContainText('Gbenga Osinaike');
  await expect(page.locator('.article-meta')).toContainText('5 October 2026');
  await expect(page.getByRole('link',{name:'Read the original article',exact:true})).toHaveAttribute('href',falobi.source);
  await expect(page.locator('.article-body')).toContainText(falobi.briefing[0]);
  await expect(page.locator('.article-header')).toContainText('STORY BRIEFING');
});

test('reading list saves, persists, removes and clears', async ({page})=>{
  await page.goto('./');
  const save=page.locator('.lead-save');
  await save.click();
  await expect(save).toHaveAttribute('aria-pressed','true');
  await page.reload();
  await expect(page.locator('.lead-save')).toHaveAttribute('aria-pressed','true');
  await page.goto('./#saved');
  await expect(page.locator('.story-card')).toHaveCount(1);
  await expect(page.locator('.story-card')).toContainText(lead.title);
  await page.getByRole('button',{name:'Clear reading list',exact:true}).click();
  await expect(page.locator('.story-card')).toHaveCount(0);
  await expect(page.getByText('A little room for good reading.')).toBeVisible();
});

test('search finds named contributors and handles empty results', async ({page})=>{
  await page.goto('./');
  await page.getByRole('button',{name:'Search stories',exact:true}).click();
  await page.getByLabel('Search headlines, topics or authors').fill('Gbenga Osinaike');
  await page.locator('#search-form').getByRole('button',{name:'Search',exact:true}).click();
  await expect(page.locator('.story-card')).toHaveCount(3);
  await page.getByRole('searchbox', {name:'Search stories',exact:true}).fill('zzzznonexistent');
  await page.locator('#page-search').getByRole('button',{name:'Search',exact:true}).click();
  await expect(page.getByRole('heading',{name:'No matching stories.'})).toBeVisible();
});

test('dialogs, keyboard dismissal and skip navigation work', async ({page})=>{
  await page.goto('./');
  await page.getByRole('button',{name:'Search stories',exact:true}).click();
  await expect(page.locator('#search-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#search-dialog')).not.toBeVisible();
  await page.keyboard.press('Tab');
  await page.getByRole('link',{name:'Skip to content',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('h1')).toHaveText(lead.title);
  await expect(page.locator('#main')).toBeFocused();
  if(await page.locator('[data-menu]').isVisible()){
    await page.getByRole('button',{name:'Open sections menu'}).click();
    await expect(page.locator('#menu-dialog')).toBeVisible();
    await page.locator('#menu-dialog').getByRole('link',{name:'Business',exact:true}).click();
    await expect(page.locator('h1')).toHaveText('Business');
  }
});

test('all sections and company pages render without overflow or browser errors', async ({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const route of ['home','about','contact','advertise','saved','section/news','section/features','section/interviews','section/business','section/health','section/opinion','section/publishers-note']){
    await page.goto('./#'+route);
    await expect(page.locator('h1')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  }
  expect(errors).toEqual([]);
});

test('every selected story resolves to a briefing with its original source link', async ({page})=>{
  for(const story of edition.stories){
    await page.goto('./#story/'+story.slug);
    await expect(page.locator('h1')).toHaveText(story.title);
    await expect(page.getByRole('link',{name:'Read the original article',exact:true})).toHaveAttribute('href',story.source);
  }
});

test('search query is rendered as text, not executable markup', async ({page})=>{
  await page.goto('./#search/'+encodeURIComponent('<img src=x onerror=alert(1)>'));
  await expect(page.locator('h1')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('h1 img')).toHaveCount(0);
});

test('published contact details and update requests have honest destinations', async ({page})=>{
  await page.goto('./#contact');
  await expect(page.getByRole('link',{name:'info@churchtimesnigeria.net',exact:true})).toHaveAttribute('href','mailto:info@churchtimesnigeria.net');
  await expect(page.getByRole('link',{name:'+234 803 333 6243',exact:true})).toHaveAttribute('href','tel:+2348033336243');
  await expect(page.locator('.connect-action')).toContainText('You are not automatically subscribed.');
  await expect(page.getByRole('link',{name:'Request updates',exact:true})).toHaveAttribute('href',/^mailto:info@churchtimesnigeria\.net/);
});
