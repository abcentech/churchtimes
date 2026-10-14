import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const cms=process.env.PUBLIC_CMS_TEST_URL;
test('anonymous public live page shows real published feed, delayed approvals and ended archives',async({page,request},testInfo)=>{
 const f=await (await request.get(cms+'/__test/fixtures')).json();
 await request.post(cms+'/__test/live-stage?stage=start');
 const feed=await (await request.get(cms+'/api/live-events/'+f.liveSlug+'/updates')).json();
 expect(Object.keys(feed.docs[0]).sort()).toEqual(['approvedAt','body','id','occurredAt','sequence']);
 await page.goto('/#live');await expect(page.locator('#live-event-title')).toHaveText(f.liveTitle);
 await expect(page.locator('#live-timeline')).toContainText('First published update');await expect(page.locator('#live-timeline')).toContainText('Second published update');await expect(page.locator('main')).not.toContainText('PRIVATE');
 const paused=page.locator('#live-pause');await paused.click();await expect(paused).toHaveAttribute('aria-pressed','true');
 expect((await request.post(cms+'/__test/live-stage?stage=approve')).status()).toBe(200);await page.getByRole('button',{name:'Refresh updates',exact:true}).click();
 await expect(page.locator('#live-timeline')).toContainText('Delayed approval with an earlier occurrence');
 const sequences=await page.locator('#live-timeline li').evaluateAll(rows=>rows.map(r=>Number(r.dataset.sequence)));expect(sequences).toEqual([1,2,3]);
 await page.getByRole('button',{name:'Refresh updates',exact:true}).click();await expect(page.locator('#live-timeline li')).toHaveCount(3);
 expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
 if(process.env.CAPTURE_PUBLIC_LIVE==='1'){await page.mouse.move(0,0);await page.evaluate(()=>document.activeElement?.blur());}
 if(process.env.CAPTURE_PUBLIC_LIVE==='1')await page.screenshot({path:`docs/public-live/live-${testInfo.project.name}.png`,fullPage:true});
 await request.post(cms+'/__test/live-stage?stage=end');await page.getByRole('button',{name:'Refresh updates',exact:true}).click();await expect(page.locator('#live-event-status')).toHaveText('Coverage ended');await expect(page.locator('#live-pause')).toBeHidden();
 if(process.env.CAPTURE_PUBLIC_LIVE==='1'){await page.mouse.move(0,0);await page.evaluate(()=>document.activeElement?.blur());}
 if(process.env.CAPTURE_PUBLIC_LIVE==='1')await page.screenshot({path:`docs/public-live/ended-${testInfo.project.name}.png`,fullPage:true});
 await page.goto('/#live/'+f.endedLiveSlug);await expect(page.locator('#live-timeline')).toContainText('Ended event published update');
 await page.goto('/#live/'+f.draftLiveSlug);await expect(page.locator('#live-error')).toContainText('Coverage unavailable');await expect(page.locator('main')).not.toContainText('PRIVATE');await expect(page.locator('#live-timeline li')).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
