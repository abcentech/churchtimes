import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchLiveEvents,fetchLiveUpdates,normalizeLiveEvent,normalizeLiveUpdate} from '../src/lib/public-live.js';
const event={id:1,slug:'public-event',title:'Public event',status:'live',author:{email:'private'},category:{title:'News'}};
const update={id:1,sequence:1,body:'<script>plain text</script>\nSecond line',occurredAt:'2026-10-14T08:00:00Z',approvedAt:'2026-10-14T08:05:00Z',author:{email:'private'},approvedBy:3};
test('live models allow only public event states and whitelist plain-text update fields',()=>{
 assert.equal(normalizeLiveEvent({...event,status:'draft'}),null);assert.equal(normalizeLiveEvent({...event,slug:'../private'}),null);assert.equal(normalizeLiveEvent(event).author,undefined);
 assert.deepEqual(Object.keys(normalizeLiveUpdate(update)),['id','sequence','body','occurredAt','approvedAt']);assert.match(normalizeLiveUpdate(update).body,/<script>/);assert.equal(normalizeLiveUpdate({...update,status:'pending'}),null);assert.equal(normalizeLiveUpdate({...update,sequence:0}),null);
});
test('anonymous event discovery explicitly requests live/ended, sort and real pagination',async()=>{
 const result=await fetchLiveEvents({baseUrl:'https://cms.example.test',fetchImpl:async(url,options)=>{const u=new URL(url);assert.equal(u.pathname,'/api/live-events');assert.equal(u.searchParams.get('where[status][in]'),'live,ended');assert.equal(u.searchParams.get('sort'),'-startedAt');assert.equal(options.credentials,'omit');assert.equal(options.headers.Authorization,undefined);return Response.json({docs:[event,{...event,status:'draft'}],hasNextPage:true,nextPage:2});}});assert.equal(result.events.length,1);assert.equal(result.nextPage,2);
});
test('public feed uses publication cursor and orders delayed approvals by their public sequence',async()=>{
 const data=await fetchLiveUpdates({baseUrl:'http://cms.churchtimes.localhost:3400',slug:event.slug,since:1,limit:2,fetchImpl:async(url,options)=>{const u=new URL(url);assert.equal(u.pathname,'/api/live-events/public-event/updates');assert.equal(u.searchParams.get('since'),'1');assert.equal(u.searchParams.get('limit'),'2');assert.equal(options.credentials,'omit');return Response.json({event,docs:[{...update,id:3,sequence:3,occurredAt:'2026-10-13T01:00:00Z'},{...update,id:2,sequence:2}],nextSince:3});}});assert.deepEqual(data.updates.map(u=>u.sequence),[2,3]);assert.equal(data.hasMore,true);assert.equal(data.nextSince,3);
});
test('malformed events/cursors, private states and errors never become fictional coverage',async()=>{
 for(const payload of [{event:{...event,status:'draft'},docs:[update],nextSince:1},{event,docs:[{...update,status:'rejected'}],nextSince:1},{event,docs:[],nextSince:4},{event,docs:[update],nextSince:0}])await assert.rejects(fetchLiveUpdates({baseUrl:'https://cms.example.test',slug:event.slug,fetchImpl:async()=>Response.json(payload)}),e=>e.type==='response');
 await assert.rejects(fetchLiveUpdates({baseUrl:'https://cms.example.test',slug:'../admin'}),e=>e.type==='configuration');
 await assert.rejects(fetchLiveUpdates({baseUrl:'https://cms.example.test',slug:event.slug,fetchImpl:async()=>new Response('',{status:404})}),e=>e.status===404);
 await assert.rejects(fetchLiveEvents({baseUrl:'http://remote.example.test'}),e=>e.type==='configuration');
});
test('timeouts, rate limits and navigation aborts stay distinguishable with no credentials',async()=>{
 await assert.rejects(fetchLiveEvents({baseUrl:'https://cms.example.test',timeoutMs:5,fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))))}),e=>e.type==='timeout');
 await assert.rejects(fetchLiveEvents({baseUrl:'https://cms.example.test',fetchImpl:async()=>new Response('',{status:429,headers:{'Retry-After':'15'}})}),e=>e.status===429&&e.retryAfter===15);
 const controller=new AbortController();controller.abort();let calls=0;await assert.rejects(fetchLiveEvents({baseUrl:'https://cms.example.test',signal:controller.signal,fetchImpl:()=>{calls++;}}),e=>e.type==='cancelled');assert.equal(calls,0);
});
