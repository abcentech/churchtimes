import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const cms = process.env.PUBLIC_CMS_TEST_URL;
const ssr = process.env.PUBLIC_SSR_TEST_URL;
const VIDEO_HOST = /(^|\.)((youtube|youtube-nocookie|youtu|ytimg|googlevideo)\.(com|be))$/i;
const hostOf = request => new URL(request.url()).hostname;

async function fixtures(request) {
  return (await (await request.get(cms + '/__test/fixtures')).json());
}

// The video-host HTTP response is STUBBED; the article and live API use the real local Payload/PostgreSQL.
async function gateVideoHosts(page) {
  const requests = [];
  page.on('request', request => { if (VIDEO_HOST.test(hostOf(request))) requests.push(request.url()); });
  await page.route('**/*', async (route, request) => {
    if (VIDEO_HOST.test(hostOf(request))) return route.fulfill({status:200,contentType:'text/html',body:'Synthetic video player'});
    return route.continue();
  });
  return requests;
}

test('article loads no video host or player until keyboard play, then builds the privacy-enhanced frame', async ({page,request}) => {
  const f = await fixtures(request);
  const requests = await gateVideoHosts(page);
  const playerRequests = [];
  page.on('request', request => { if (/youtube-player(?:-|\.js)/.test(new URL(request.url()).pathname)) playerRequests.push(request.url()); });
  await page.goto(ssr + '/reports/' + f.videoArticleSlug + '/');
  const video = page.locator('.youtube-video');
  await expect(video).toContainText('Synthetic service');
  await expect(video).toContainText('Plays from YouTube');
  await expect(video.locator('iframe')).toHaveCount(0);
  await expect(video.getByRole('link',{name:'Watch on YouTube'})).toHaveAttribute('href','https://www.youtube.com/watch?v=aB3_deF-123&t=65s');
  expect(requests).toEqual([]);
  expect(playerRequests).toEqual([]);
  const storage = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
  expect(storage.filter(key => key !== 'ct-optional-consent-v1')).toEqual([]);
  expect((await new AxeBuilder({page}).include('.youtube-video').withTags(['wcag2a','wcag2aa']).analyze()).violations).toEqual([]);
  expect(requests).toEqual([]);
  const load = page.waitForRequest(request => request.url().startsWith('https://www.youtube-nocookie.com/embed/'));
  await video.getByRole('button',{name:'Play YouTube video: Synthetic service'}).focus();
  await page.keyboard.press('Enter');
  await load;
  const frame = video.locator('iframe');
  await expect(frame).toHaveAttribute('src','https://www.youtube-nocookie.com/embed/aB3_deF-123?autoplay=1&start=65');
  await expect(frame).toHaveAttribute('title','Play YouTube video: Synthetic service');
  await expect(frame).toHaveAttribute('loading','lazy');
  await expect(frame).toHaveAttribute('referrerpolicy','strict-origin-when-cross-origin');
  await expect(frame).toHaveAttribute('allow','autoplay; fullscreen');
  expect(requests).toHaveLength(1);
  expect(playerRequests).toHaveLength(1);
});

test('article fallback link is usable with JavaScript disabled', async ({browser,request}) => {
  const f = await fixtures(request);
  const context = await browser.newContext({javaScriptEnabled:false});
  await context.route('https://www.youtube.com/**', route => route.fulfill({status:200,contentType:'text/html',body:'Synthetic fallback destination'}));
  const page = await context.newPage();
  try {
    await page.goto(ssr + '/reports/' + f.videoArticleSlug + '/');
    const video = page.locator('.youtube-video');
    await expect(video.locator('iframe')).toHaveCount(0);
    await expect(video.locator('[data-youtube-play]')).toBeHidden();
    await expect(video.locator('.youtube-static')).toBeVisible();
    await video.getByRole('link',{name:'Watch on YouTube'}).click();
    await expect(page).toHaveURL('https://www.youtube.com/watch?v=aB3_deF-123&t=65s');
    await expect(page.locator('body')).toHaveText('Synthetic fallback destination');
  } finally { await context.close(); }
});

test('data saver does not autoplay and offline playback leaves the fallback available', async ({page,request}) => {
  const f = await fixtures(request);
  await page.addInitScript(() => Object.defineProperty(navigator,'connection',{configurable:true,value:{saveData:true}}));
  const requests = await gateVideoHosts(page);
  await page.goto(ssr + '/reports/' + f.videoArticleSlug + '/');
  const video = page.locator('.youtube-video');
  await expect(video.getByRole('button',{name:/Play YouTube video/})).toBeVisible();
  await page.context().setOffline(true);
  await video.getByRole('button',{name:/Play YouTube video/}).click();
  await expect(video.locator('[role=status]')).toContainText('offline');
  await expect(video.locator('iframe')).toHaveCount(0);
  expect(requests).toEqual([]);
  await page.context().setOffline(false);
  await video.getByRole('button',{name:/Play YouTube video/}).click();
  await expect(video.locator('iframe')).toHaveAttribute('src','https://www.youtube-nocookie.com/embed/aB3_deF-123?start=65');
  await expect(video.getByRole('link',{name:'Watch on YouTube'})).toBeVisible();
});

test('published live update uses the same gated player; pending video stays hidden', async ({page,request}) => {
  const f = await fixtures(request);
  const requests = await gateVideoHosts(page);
  await page.goto('/#live/' + f.videoLiveSlug);
  const video = page.locator('#live-timeline .youtube-video');
  await expect(page.locator('#live-timeline')).toContainText('Synthetic video update');
  await expect(page.locator('#live-timeline')).not.toContainText('PRIVATE video update');
  await expect(video).toContainText('Synthetic live service');
  await expect(video.locator('iframe')).toHaveCount(0);
  expect(requests).toEqual([]);
  await video.getByRole('button',{name:'Play YouTube video: Synthetic live service'}).click();
  await expect(video.locator('iframe')).toHaveAttribute('src','https://www.youtube-nocookie.com/embed/aB3_deF-123?autoplay=1&start=65');
});
