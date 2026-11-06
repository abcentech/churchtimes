import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('church calendar page reads without JavaScript and fits the viewport',async({browser})=>{
  const context=await browser.newContext({javaScriptEnabled:false});
  const page=await context.newPage();
  await page.goto('/church-calendar/?year=2026');
  await expect(page.locator('h1')).toHaveText('Church calendar 2026');
  await expect(page.locator('table.ct-cal-table tbody tr')).toHaveCount(14);
  await expect(page.locator('tr',{hasText:'Easter Day'})).toContainText('Sunday 5 April');
  await expect(page.locator('.ct-cal-years a')).toHaveText(['2025','2027']);
  const width=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  expect(width).toBeLessThanOrEqual(0);
  await page.goto('/church-calendar/?year=2150');
  await expect(page.locator('.ct-cal-years a')).toHaveText(['2149','This year','2151']);
  await context.close();
});

test('church calendar: axe clean with the site stylesheet',async({page})=>{
  await page.goto('/church-calendar/');
  await expect(page.locator('.ct-cal-today')).toContainText('Today in Lagos');
  const results=await new AxeBuilder({page}).analyze();
  expect(results.violations).toEqual([]);
});
