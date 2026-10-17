import test from 'node:test';
import assert from 'node:assert/strict';
import { publicCommentId, publicCommentsEndpoint, normalizePublicComment, fetchPublicComments, COMMENTS_MAX_PAGES } from '../src/lib/public-comments.js';
const endpoint='https://cms.example.test/api/legacy-comments';
const comment={id:7,authorName:'Synthetic Reader',content:'Archived synthetic text.\nAnother line.',commentedAt:'2023-05-10T11:00:00Z',parentLegacyId:123};
const page=(docs=[comment],hasNextPage=false,nextPage=null)=>({docs,hasNextPage,nextPage});
const stub=body=>async()=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
// Synthetic contract response STUBS. No real CMS comments endpoint exists in this branch.
test('comment config and article IDs reject insecure endpoints, credentials and query injection',()=>{
  for(const id of [0,-1,'1&status=hidden','story-slug','9007199254740992',true,null])assert.equal(publicCommentId(id),'');
  assert.equal(publicCommentId(42),'42');
  for(const value of ['http://cms.example.test/api/legacy-comments','https://user@cms.example.test/api/legacy-comments','https://cms.example.test/api/legacy-comments?email=x','https://cms.example.test/api/legacy-comments#x','javascript:alert(1)'])assert.equal(publicCommentsEndpoint(value),'');
  assert.equal(publicCommentsEndpoint(endpoint),endpoint);assert.equal(publicCommentsEndpoint('http://127.0.0.1:6194/api/legacy-comments'),'http://127.0.0.1:6194/api/legacy-comments');
});
test('C6 projection accepts omitted status but rejects hidden comments and never retains private fields',()=>{
  const normalized=normalizePublicComment({...comment,email:'PRIVATE@example.test',website:'https://private.example.test',ip:'private-IP',status:'approved',article:{status:'draft'}});
  assert.deepEqual(Object.keys(normalized),['id','authorName','content','commentedAt','parentLegacyId']);
  assert.equal(JSON.stringify(normalized).includes('PRIVATE'),false);
  assert.ok(normalizePublicComment(comment));assert.equal(normalizePublicComment({...comment,status:'hidden'}),null);
  for(const override of [{id:0},{authorName:''},{content:''},{commentedAt:'not a date'}])assert.equal(normalizePublicComment({...comment,...override}),null);
});
test('anonymous GET requests exact C6 relation, sort, depth and bounded pagination (STUB)',async()=>{
  let seen;
  const result=await fetchPublicComments({endpoint,articleId:42,page:2,fetchImpl:async(url,options)=>{seen={url:new URL(url),options};return new Response(JSON.stringify(page([comment],true,3)));}});
  assert.equal(seen.url.searchParams.get('where[article][equals]'),'42');assert.equal(seen.url.searchParams.get('sort'),'commentedAt');assert.equal(seen.url.searchParams.get('limit'),'100');assert.equal(seen.url.searchParams.get('depth'),'0');assert.equal(seen.url.searchParams.get('page'),'2');
  assert.equal(seen.options.method,'GET');assert.equal(seen.options.credentials,'omit');assert.equal(seen.options.referrerPolicy,'no-referrer');assert.equal(seen.options.cache,'no-store');assert.equal(result.nextPage,3);
});
test('empty published archive is distinct from malformed/unapproved responses (STUB)',async()=>{
  assert.deepEqual(await fetchPublicComments({endpoint,articleId:1,fetchImpl:stub(page([]))}),{comments:[],nextPage:null,truncated:false,incomplete:false});
  for(const body of [{docs:[]},page([{}]),page([{...comment,status:'hidden'}]),page([],true,1),page([],true,2),page([],true,3),page(Array.from({length:101},()=>comment))])await assert.rejects(fetchPublicComments({endpoint,articleId:1,fetchImpl:stub(body)}),e=>e.type==='response');
});
test('pagination cannot loop or exceed twenty explicit pages (STUB)',async()=>{
  const result=await fetchPublicComments({endpoint,articleId:1,page:COMMENTS_MAX_PAGES,fetchImpl:stub(page([comment],true,COMMENTS_MAX_PAGES+1))});assert.equal(result.nextPage,null);assert.equal(result.truncated,true);
  for(const value of [0,-1,21,1.5,'2'])await assert.rejects(fetchPublicComments({endpoint,articleId:1,page:value,fetchImpl:()=>assert.fail('No request')}),e=>e.type==='configuration');
});
test('every HTTP failure remains unavailable, and Retry-After is bounded (STUB)',async()=>{
  for(const status of [400,401,403,404,429,500,503])await assert.rejects(fetchPublicComments({endpoint,articleId:1,fetchImpl:async()=>new Response('{}',{status,headers:{'Retry-After':'99999999999'}})}),e=>e.type==='http'&&e.status===status&&(status!==429||e.retryAfter===86400));
});
test('malformed, oversized and partial archives never become a false empty success (STUB)',async()=>{
  await assert.rejects(fetchPublicComments({endpoint,articleId:1,fetchImpl:async()=>new Response('not JSON')}),e=>e.type==='response');
  await assert.rejects(fetchPublicComments({endpoint,articleId:1,fetchImpl:async()=>new Response('{}',{headers:{'Content-Length':'999999999'}})}),e=>e.type==='response');
  const result=await fetchPublicComments({endpoint,articleId:1,fetchImpl:stub(page([comment,{id:8}]))});assert.equal(result.comments.length,1);assert.equal(result.incomplete,true);
});
test('navigation cancellation and timeouts terminate even a stalled fetch/body STUB',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(fetchPublicComments({endpoint,articleId:1,signal:controller.signal,fetchImpl:()=>assert.fail('No request')}),e=>e.type==='cancelled');
  await assert.rejects(fetchPublicComments({endpoint,articleId:1,timeoutMs:5,fetchImpl:()=>new Promise(()=>{})}),e=>e.type==='timeout');
  await assert.rejects(fetchPublicComments({endpoint,articleId:1,timeoutMs:5,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))}),e=>e.type==='timeout');
  const active=new AbortController();const pending=fetchPublicComments({endpoint,articleId:1,signal:active.signal,fetchImpl:()=>new Promise(()=>{})});active.abort();await assert.rejects(pending,e=>e.type==='cancelled');
});
test('actual streamed oversized bodies are capped even without a length header (STUB)',async()=>{
  await assert.rejects(fetchPublicComments({endpoint,articleId:1,fetchImpl:async()=>new Response('x'.repeat(2*1024*1024+1))}),e=>e.type==='response');
});
test('comment dates reject calendar rollover and ambiguous formats while retaining valid offsets',()=>{
  for(const date of ['2023-02-30T11:00:00Z','2023-04-31T11:00:00Z','2023-05-10T24:00:00Z','2023-05-10','not a date'])assert.equal(normalizePublicComment({...comment,commentedAt:date}),null);
  assert.equal(normalizePublicComment({...comment,commentedAt:'2024-02-29T00:30:00+01:00'}).commentedAt,'2024-02-28T23:30:00.000Z');
});
