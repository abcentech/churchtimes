import test from 'node:test';
import assert from 'node:assert/strict';
import { postReaderForm, readerEndpoint, newsletterTokenEndpoint, validateReaderForm, boundedRetryAfter, captureNewsletterLink } from '../src/lib/reader-form-contracts.js';
const newsletter = { email:'reader@example.test', name:'Test Reader', consent:true, source:'footer' };
const contact = { name:'Test Reader',email:'reader@example.test',topic:'general',message:'Synthetic reader message for contract testing.' };
const endpoint='https://cms.example.test/api/public/newsletter/subscribe';
// Contract fixtures and synthetic fetch STUBS, not real CMS end-to-end validation.
function stub(status,data,headers={}) { return async()=>new Response(JSON.stringify(data),{status,headers}); }
test('reader endpoint protects personal data and token endpoint has no query',()=>{
  for(const value of ['http://remote.example.test/x','javascript:alert(1)','https://x.test/a?secret=x','https://user@x.test/a','https://x.test/a#token']) assert.equal(readerEndpoint(value),'');
  assert.equal(newsletterTokenEndpoint(endpoint,'confirm'),'https://cms.example.test/api/public/newsletter/confirm');
  assert.equal(newsletterTokenEndpoint(endpoint,'other'),'');
});
test('C4/C5 synthetic payload projection and neutral statuses',async()=>{
  let seen;
  for(const [kind,values,status,result] of [['newsletter',newsletter,202,{ok:true}],['contact',contact,201,{ok:true,reference:'MSG-7KQ2M9XA'}],['confirm',{},200,{ok:true}],['unsubscribe',{},200,{ok:true}]]) {
    await postReaderForm({endpoint,kind,values,token:'synthetic-token',fetchImpl:async(url,options)=>{seen=options;return new Response(JSON.stringify(result),{status});}});
    assert.equal(seen.method,'POST');assert.equal(seen.credentials,'omit');assert.equal(seen.referrerPolicy,'no-referrer');assert.equal(seen.cache,'no-store');
    const body=JSON.parse(seen.body); assert.equal(body.token||body.turnstileToken,'synthetic-token');assert.equal(body.phone,undefined);assert.equal(body.subject,undefined);
  }
});
test('all C4/C5 contract error responses are typed without reflecting server text (STUB)',async()=>{
  for(const [status,type] of [[400,'validation'],[403,'forbidden'],[409,'duplicate'],[413,'size'],[415,'configuration'],[429,'rate-limit'],[503,'unavailable'],[500,'server'],[200,'unconfirmed']]) {
    await assert.rejects(postReaderForm({endpoint,kind:'newsletter',values:newsletter,token:'token',fetchImpl:stub(status,{ok:false,errors:[{field:'email',message:'<script>private</script>'}]},{'Retry-After':'9999999999'})}),error=>error.type===type && (status!==429||error.retryAfter===86400));
  }
  await assert.rejects(postReaderForm({endpoint,kind:'confirm',token:'expired',fetchImpl:stub(400,{ok:false})}),error=>error.type==='invalid-token');
  await assert.rejects(postReaderForm({endpoint,kind:'contact',values:contact,token:'token',fetchImpl:stub(400,{errors:[{field:'turnstileToken'}]})}),error=>error.type==='challenge');
});
test('client validators follow newsletter and contact field limits',()=>{
  assert.deepEqual(validateReaderForm(newsletter,'newsletter'),{});assert.deepEqual(validateReaderForm(contact,'contact'),{});
  assert.ok(validateReaderForm({...newsletter,consent:'true'},'newsletter').consent);
  assert.ok(validateReaderForm({...contact,message:'too short'},'contact').message);
  assert.ok(validateReaderForm({...contact,topic:'staff'},'contact').topic);
  assert.ok(validateReaderForm({...newsletter,name:'a'},'newsletter').name);
});
test('Retry-After clamps dates/numeric values and defaults safely',()=>{
  assert.equal(boundedRetryAfter('9999999999'),86400);assert.equal(boundedRetryAfter('-1'),60);assert.equal(boundedRetryAfter('bad'),60);assert.equal(boundedRetryAfter('0'),60);
  assert.equal(boundedRetryAfter(new Date(120000).toUTCString(),0),120);
});
test('newsletter tokens are captured and stripped without submission or persistence',()=>{
  let replacement;
  const history={replaceState:(_state,_title,url)=>replacement=url};
  assert.deepEqual(captureNewsletterLink({pathname:'/newsletter/confirm',search:'?token=synthetic&extra=x'},history),{action:'confirm',token:'synthetic'});
  assert.equal(replacement,'/newsletter/confirm');
  assert.deepEqual(captureNewsletterLink({pathname:'/preview/newsletter/unsubscribe/',search:'?token=x&token=y'},history,'/preview/'),{action:'unsubscribe',token:''});
  assert.equal(captureNewsletterLink({pathname:'/unrelated',search:'?token=keep'},history),null);
});
test('cancellation and network STUB failures never claim receipt',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(postReaderForm({endpoint,kind:'confirm',token:'x',signal:controller.signal,fetchImpl:()=>assert.fail('No request after abort')}),e=>e.type==='cancelled');
  await assert.rejects(postReaderForm({endpoint,kind:'confirm',token:'x',fetchImpl:async()=>{throw Error('offline');}}),e=>e.type==='network');
});
test('malformed error payload shapes remain typed and safe (STUB)',async()=>{
  for(const errors of [{field:'email'},[null,4,{}, {field:'email'}],'bad']) {
    await assert.rejects(postReaderForm({endpoint,kind:'newsletter',values:newsletter,token:'x',fetchImpl:stub(400,{errors})}),error=>error.type==='validation');
  }
});
test('static clean newsletter routes ignore misleading document base and scrub all query/fragment data',()=>{
  for (const path of ['/newsletter/confirm','/newsletter/unsubscribe/','/preview/newsletter/confirm']) {
    let replaced;
    const location={pathname:path,search:'?token=synthetic&tracking=private',hash:'#private'};
    const result=captureNewsletterLink(location,{replaceState:(_a,_b,url)=>{replaced=url;}},'/newsletter/');
    assert.equal(result.token,'synthetic');assert.equal(result.action,path.includes('confirm')?'confirm':'unsubscribe');assert.equal(replaced,path);
  }
});
test('blank optional name is omitted and rejected Turnstile 403 is distinct from an origin denial (STUB)',async()=>{
  let payload;
  await postReaderForm({endpoint,kind:'newsletter',values:{...newsletter,name:'  '},token:'x',fetchImpl:async(_url,options)=>{payload=JSON.parse(options.body);return new Response('{"ok":true}',{status:202});}});
  assert.equal(Object.hasOwn(payload,'name'),false);
  for(const [errors,type] of [[[null,{field:'turnstileToken',message:'private'}],'challenge'],[[{message:'private origin'}],'forbidden']]) {
    await assert.rejects(postReaderForm({endpoint,kind:'newsletter',values:newsletter,token:'x',fetchImpl:stub(403,{errors})}),error=>error.type===type);
  }
});
test('C5 receipt accepts exactly eight unambiguous contract characters (STUB)',async()=>{
  for(const reference of ['MSG-SYNTHETIC','MSG-12345678','MSG-7KQ2M9X','MSG-7KQ2M9XAA','MSG-7KQ2M9XI','MSG-7KQ2M9XO']) {
    await assert.rejects(postReaderForm({endpoint,kind:'contact',values:contact,token:'x',fetchImpl:stub(201,{ok:true,reference})}),error=>error.type==='unconfirmed');
  }
  assert.deepEqual(await postReaderForm({endpoint,kind:'contact',values:contact,token:'x',fetchImpl:stub(201,{ok:true,reference:'MSG-7KQ2M9XA'})}),{reference:'MSG-7KQ2M9XA'});
});
