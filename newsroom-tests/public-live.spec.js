import {test,expect} from '@playwright/test';
const event={slug:'public-live',title:'Public live coverage',status:'live',summary:'Public summary'};
const row=n=>({id:n,sequence:n,body:n===1?'<script>unsafe</script>\nA literal public update':`Published update ${n}`,approvedAt:'2026-10-14T08:00:00Z'});
async function mock(page,{state='live',fail=false,full=false}={}) {
 await page.route('**/api/live-events?**',r=>r.fulfill({json:{docs:[{...event,status:state},{...event,slug:'private-event',title:'PRIVATE event',status:'draft'}]}}));
 const calls=[];await page.route('**/api/live-events/*/updates?**',r=>{
  const u=new URL(r.request().url());calls.push(Number(u.searchParams.get('since')));
  const since=calls.at(-1);return fail?r.fulfill({status:503,json:{message:'PRIVATE diagnostics'}}):r.fulfill({json:{event:{...event,status:state},docs:since?[]:Array.from({length:full?50:1},(_,i)=>row(i+1)),nextSince:since|| (full?50:1)}});
 });return calls;
}
test('live updates remain plain text and polling can pause, resume and cancel on navigation',async({page})=>{
 await page.clock.install();const calls=await mock(page);await page.goto('/#live');await expect(page.locator('#live-timeline')).toContainText('<script>unsafe</script>');await expect(page.locator('#live-timeline script')).toHaveCount(0);await expect(page.locator('main')).not.toContainText('PRIVATE event');
 await page.getByRole('button',{name:'Pause automatic updates'}).click();await page.clock.fastForward(60000);expect(calls).toEqual([0]);
 await page.getByRole('button',{name:'Resume automatic updates'}).click();await page.clock.fastForward(15000);await expect.poll(()=>calls.length).toBe(2);expect(calls).toEqual([0,1]);
 await page.getByRole('link',{name:'Church Times Nigeria home',exact:true}).first().click();await page.clock.fastForward(60000);expect(calls).toHaveLength(2);await expect(page.locator('.lead-story h1')).toBeVisible();
});
test('ended archives support batch pagination and stop automatic refreshes',async({page})=>{
 await page.clock.install();const calls=await mock(page,{state:'ended',full:true});await page.goto('/#live/public-live');await expect(page.locator('#live-timeline li')).toHaveCount(50);await expect(page.getByRole('button',{name:'Load more published updates'})).toBeVisible();
 await page.getByRole('button',{name:'Load more published updates'}).click();await expect.poll(()=>calls.length).toBe(2);expect(calls).toEqual([0,50]);await page.clock.fastForward(60000);expect(calls).toHaveLength(2);
 await expect(page.locator('#live-timeline li')).toHaveCount(50);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('feed failure preserves published updates and safe retry resumes from the cursor',async({page})=>{
 const calls=await mock(page);await page.goto('/#live');await expect(page.locator('#live-timeline li')).toHaveCount(1);
 await page.route('**/api/live-events/*/updates?**',r=>r.fulfill({status:429,headers:{'Retry-After':'60'},json:{message:'PRIVATE diagnostics'}}));await page.getByRole('button',{name:'Refresh updates',exact:true}).click();await expect(page.locator('#live-error')).toContainText('too many requests');await expect(page.locator('#live-error')).not.toContainText('PRIVATE');await expect(page.locator('#live-timeline li')).toHaveCount(1);
 await page.unroute('**/api/live-events/*/updates?**');await page.route('**/api/live-events/*/updates?**',r=>{calls.push(Number(new URL(r.request().url()).searchParams.get('since')));return r.fulfill({json:{event,docs:[row(2)],nextSince:2}});});
 await page.getByRole('button',{name:'Refresh updates',exact:true}).click();await expect(page.locator('#live-timeline li')).toHaveCount(2);expect(calls.at(-1)).toBe(1);
});
test('unavailable events and discovery failures stay navigable without private or invented updates',async({page})=>{
 await page.route('**/api/live-events?**',r=>r.fulfill({status:403,json:{message:'PRIVATE'}}));await page.goto('/#live');await expect(page.locator('#live-discovery')).toContainText('Public reporting is unavailable');await expect(page.locator('main')).not.toContainText('PRIVATE');
 await page.route('**/api/live-events?**',r=>r.fulfill({json:{docs:[]}}));await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.locator('#live-discovery')).toContainText('No live or ended coverage');
});
test('hidden tabs stop polling and visibility resumes one incremental request',async({page})=>{
 await page.clock.install();const calls=await mock(page);await page.goto('/#live');await expect(page.locator('#live-timeline li')).toHaveCount(1);
 await page.evaluate(()=>{window.__liveHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__liveHidden});document.dispatchEvent(new Event('visibilitychange'));});await page.clock.fastForward(60000);expect(calls).toEqual([0]);
 await page.evaluate(()=>{window.__liveHidden=false;document.dispatchEvent(new Event('visibilitychange'));});await page.clock.fastForward(15000);await expect.poll(()=>calls.length).toBe(2);expect(calls).toEqual([0,1]);
});
