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
test('an event that becomes unavailable clears its cursor and can reload when public again',async({page})=>{
 await mock(page);await page.goto('/#live');await expect(page.locator('#live-timeline li')).toHaveCount(1);
 await page.route('**/api/live-events/*/updates?**',r=>r.fulfill({status:404,json:{message:'PRIVATE'}}));await page.getByRole('button',{name:'Refresh updates',exact:true}).click();await expect(page.locator('#live-error')).toContainText('Coverage unavailable');await expect(page.locator('#live-timeline li')).toHaveCount(0);
 await page.unroute('**/api/live-events/*/updates?**');let cursor;
 await page.route('**/api/live-events/*/updates?**',r=>{cursor=Number(new URL(r.request().url()).searchParams.get('since'));return r.fulfill({json:{event,docs:[row(1)],nextSince:1}});});await page.getByRole('button',{name:'Refresh updates',exact:true}).click();await expect(page.locator('#live-timeline li')).toHaveCount(1);expect(cursor).toBe(0);await expect(page.locator('#live-error')).toBeHidden();
});

const livePhotoBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAASCAIAAAC1qksFAAAAH0lEQVR4nGMQ19ajKWIYtWDUglELRi0YtWDUAnpYAABhZ/wBEOKdzAAAAABJRU5ErkJggg==','base64');
const photo=(name,extra={})=>({url:`/api/media/file/${name}.png`,alt:`Synthetic ${name} photograph`,width:32,height:18,mimeType:'image/png',...extra});

test('live photos render safely above text and same-id edits replace, reorder and remove them',async({page})=>{
 await page.clock.install();await mock(page);
 await page.route('**/api/media/file/*.png',r=>r.fulfill({contentType:'image/png',body:livePhotoBytes}));
 const responses=[
  {docs:[{...row(1),image:photo('first')},row(2)],nextSince:2},
  {docs:[{...row(1),sequence:3,body:'Revised approved text',image:photo('replacement',{alt:'<img src=x onerror="window.compromised=true">'})}],nextSince:3},
  {docs:[{...row(1),sequence:4,body:'Approved text with photograph removed',image:null}],nextSince:4},
 ];let batch=0;
 await page.route('**/api/live-events/*/updates?**',r=>r.fulfill({json:{event,...responses[Math.min(batch++,2)]}}));
 await page.goto('/#live');const first=page.locator('#live-timeline li[data-id="1"]');
 await expect(first.locator('img')).toHaveAttribute('alt','Synthetic first photograph');
 await expect(first.locator('img')).toHaveAttribute('src','http://127.0.0.1:5174/api/media/file/first.png');
 await expect(first.locator('img')).toHaveAttribute('loading','lazy');await expect(first.locator('img')).toHaveAttribute('width','32');await expect(first.locator('img')).toHaveAttribute('height','18');
 expect(await first.evaluate(el=>el.querySelector('figure').compareDocumentPosition(el.querySelector('.live-update-body'))&Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
 await first.locator('img').scrollIntoViewIfNeeded();await expect.poll(()=>first.locator('img').evaluate(img=>img.naturalWidth)).toBe(32);
 await page.getByRole('button',{name:'Refresh updates',exact:true}).click();
 await expect(first).toContainText('Revised approved text');await expect(page.locator('#live-timeline li')).toHaveCount(2);
 await expect(first.locator('img')).toHaveAttribute('src','http://127.0.0.1:5174/api/media/file/replacement.png');
 await expect(first.locator('img')).toHaveAttribute('alt','<img src=x onerror="window.compromised=true">');
 expect(await page.locator('#live-timeline li').evaluateAll(els=>els.map(el=>el.dataset.id))).toEqual(['2','1']);
 await expect(page.locator('#live-announcement')).toContainText('1 update revised');
 expect(await page.evaluate(()=>window.compromised)).toBeUndefined();
 await page.getByRole('button',{name:'Refresh updates',exact:true}).click();
 await expect(first).toContainText('Approved text with photograph removed');await expect(first.locator('figure,img')).toHaveCount(0);await expect(page.locator('#live-timeline li')).toHaveCount(2);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('unknown photo dimensions reserve space and failed photos leave update text intact',async({page})=>{
 await page.clock.install();await mock(page);
 await page.route('**/api/media/file/unknown.png',r=>r.fulfill({contentType:'image/png',body:livePhotoBytes}));
 await page.route('**/api/live-events/*/updates?**',r=>r.fulfill({json:{event,docs:[{...row(1),image:photo('unknown',{width:null,height:null})}],nextSince:1}}));
 await page.goto('/#live');const figure=page.locator('#live-timeline figure');
 await expect(figure).toHaveCSS('aspect-ratio','16 / 9');expect(await figure.locator('img').getAttribute('width')).toBeNull();expect(await figure.locator('img').getAttribute('height')).toBeNull();
 let release;const gate=new Promise(resolve=>release=resolve);
 await page.route('**/api/media/file/broken.png',async r=>{await gate;await r.abort('failed');});
 await page.route('**/api/live-events/*/updates?**',r=>r.fulfill({json:{event,docs:[{...row(1),sequence:2,body:'Text survives an unavailable photograph',image:photo('broken')}],nextSince:2}}));
 await page.getByRole('button',{name:'Refresh updates',exact:true}).click();
 await expect(page.locator('#live-timeline')).toContainText('Text survives an unavailable photograph');
 const image=page.locator('#live-timeline img');await image.scrollIntoViewIfNeeded();release();
 await expect(page.locator('#live-timeline figure')).toHaveCount(0);await expect(page.locator('#live-timeline li')).toHaveCount(1);
});

test('a day-long Retry-After resumes automatic refresh within ten minutes',async({page})=>{
 await page.clock.install();await mock(page);await page.goto('/#live');await expect(page.locator('#live-timeline li')).toHaveCount(1);
 let calls=0;await page.route('**/api/live-events/*/updates?**',r=>++calls===1?r.fulfill({status:429,headers:{'Retry-After':'86400'},json:{}}):r.fulfill({json:{event,docs:[],nextSince:1}}));
 await page.getByRole('button',{name:'Refresh updates',exact:true}).click();await expect(page.locator('#live-error')).toBeVisible();
 await page.clock.fastForward(599000);expect(calls).toBe(1);
 await page.clock.fastForward(1000);await expect.poll(()=>calls).toBe(2);await expect(page.locator('#live-error')).toBeHidden();
});

test('invalid live links still discover events and wait for explicit selection',async({page})=>{
 const calls=await mock(page);await page.goto('/#live/not_valid');
 await expect(page.locator('#live-discovery')).toContainText('Coverage unavailable');await expect(page.locator('#live-discovery a')).toHaveCount(1);
 await expect(page.locator('#live-event')).toBeHidden();expect(calls).toEqual([]);
 await page.locator('#live-discovery a').click();await expect(page.locator('#live-timeline li')).toHaveCount(1);
});
