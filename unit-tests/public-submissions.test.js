import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSubmission, submissionPayload, submissionEndpoint, sendPublicSubmission } from '../src/lib/public-submissions.js';
const values={ name:' Reader ',email:'reader@example.test',phone:'+234 803 123 4567',title:' A local story ',message:' Key facts and source links for the community story. ',category:'News',consent:true };
const response=(status,body,headers={})=>({status,ok:status>=200&&status<300,headers:new Headers(headers),json:async()=>body});
test('required fields, email, category, consent and field lengths are validated',()=>{
  assert.equal(Object.keys(validateSubmission({})).length,7);
  assert.deepEqual(validateSubmission(values),{});
  assert.ok(validateSubmission({...values,email:'invalid'}).email);
  assert.ok(validateSubmission({...values,title:'x'.repeat(201)}).title);
  assert.ok(validateSubmission({...values,message:'x'.repeat(20001)}).message);
  assert.ok(validateSubmission({...values,consent:'true'}).consent);
  assert.equal(validateSubmission({...values,category:''},'contact').category,undefined);
});
test('endpoint configuration keeps contact separate and rejects insecure or credential URLs',()=>{
  assert.equal(submissionEndpoint({cmsUrl:'https://cms.example.test'}),'https://cms.example.test/api/public/submissions');
  assert.equal(submissionEndpoint({kind:'contact',cmsUrl:'https://cms.example.test'}),'');
  assert.equal(submissionEndpoint({storyUrl:'http://example.test/api'}),'');
  assert.equal(submissionEndpoint({storyUrl:'https://user:pass@example.test/api'}),'');
  assert.equal(submissionEndpoint({storyUrl:'javascript:alert(1)'}),'');
  assert.equal(submissionEndpoint({storyUrl:'http://127.0.0.1:3000/api'}),'http://127.0.0.1:3000/api');
});
test('phone is required and accepts local and international formatting',()=>{
  for (const phone of ['08031234567','+234 803 123 4567','+1 (202) 555-0123']) {
    assert.equal(validateSubmission({...values,phone}).phone,undefined);
  }
  for (const phone of [undefined,'','  ','call me','123','1234567890123456','++2348031234567','1'.repeat(41)]) {
    assert.ok(validateSubmission({...values,phone}).phone);
  }
  for (const kind of ['story','contact']) {
    assert.equal(submissionPayload({...values,phone:' +234 803 123 4567 '},'opaque',kind).phone,'+234 803 123 4567');
    assert.ok(validateSubmission({...values,phone:'  '},kind).phone);
  }
});
test('payload sends only intended fields and the opaque challenge token',()=>{
  assert.deepEqual(submissionPayload({...values,status:'published',role:'editor',secret:'bad'},'opaque'),{name:'Reader',email:'reader@example.test',phone:'+234 803 123 4567',title:'A local story',body:'Key facts and source links for the community story.',categorySuggestion:'News',location:'',website:'',consent:true,consentTextVersion:'2026-10',turnstileToken:'opaque'});
  assert.equal(submissionPayload(values,'opaque','contact').subject,'A local story');
  assert.equal(submissionPayload(values,'opaque','contact').body,undefined);
});
test('sends anonymous JSON and requires explicit backend receipt confirmation',async()=>{
  const result=await sendPublicSubmission({endpoint:'https://cms.example.test/api/public/submissions',values,token:'opaque',fetchImpl:async(_url,options)=>{
    assert.equal(options.method,'POST'); assert.equal(options.credentials,'omit');
    assert.equal(options.cache,'no-store'); assert.equal(options.headers.Authorization,undefined);
    assert.equal(JSON.parse(options.body).turnstileToken,'opaque');
    return response(201,{ok:true,reference:'TEST-ONLY'});
  }});
  assert.equal(result.reference,'TEST-ONLY');
  await assert.rejects(sendPublicSubmission({endpoint:'https://cms.example.test/api',values,token:'opaque',fetchImpl:async()=>response(200,{})}),e=>e.type==='unconfirmed');
});
test('missing token and invalid fields never send a request',async()=>{
  const fetchImpl=()=>assert.fail('must not call API');
  await assert.rejects(sendPublicSubmission({endpoint:'https://cms.example.test/api',values,token:'',fetchImpl}),e=>e.type==='configuration');
  await assert.rejects(sendPublicSubmission({endpoint:'https://cms.example.test/api',values:{},token:'opaque',fetchImpl}),e=>e.type==='validation');
});
test('handles rate limiting, challenge rejection, safe field errors and service failures',async()=>{
  const send=(status,body,headers)=>sendPublicSubmission({endpoint:'https://cms.example.test/api',values,token:'opaque',fetchImpl:async()=>response(status,body,headers)});
  await assert.rejects(send(429,{}, {'Retry-After':'2'}),e=>e.type==='rate-limit'&&e.retryAfter===2);
  await assert.rejects(send(403,{ok:false,errors:[{field:'turnstileToken',message:'Verification failed.'}]}),e=>e.type==='challenge');
  await assert.rejects(send(400,{ok:false,errors:[{field:'body',message:'<script>unsafe</script>'},{field:'role',message:'bad'}]}),e=>e.type==='validation'&&e.fields.message==='Please check this field and try again.'&&Object.keys(e.fields).length===1);
  await assert.rejects(send(503,{}),e=>e.type==='server');
});
test('timeouts and navigation cancellation are distinguishable and never auto-retry',async()=>{
  let calls=0;
  const fetchImpl=(_url,{signal})=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));};
  await assert.rejects(sendPublicSubmission({endpoint:'https://cms.example.test/api',values,token:'opaque',timeoutMs:5,fetchImpl}),e=>e.type==='timeout');
  assert.equal(calls,1);
  const controller=new AbortController();
  const pending=sendPublicSubmission({endpoint:'https://cms.example.test/api',values,token:'opaque',signal:controller.signal,fetchImpl});
  controller.abort();
  await assert.rejects(pending,e=>e.type==='cancelled');
});

test('maps CMS v1.2 location/category fields and rejects incompatible/false receipts',async()=>{
  const payload=submissionPayload({...values,location:' Lagos '},'opaque');assert.equal(payload.location,'Lagos');assert.equal(payload.categorySuggestion,'News');assert.equal(payload.website,'');assert.equal('category' in payload,false);assert.equal(payload.consent,true);assert.equal(payload.consentTextVersion,'2026-10');assert.equal('consent' in submissionPayload({...values,consent:undefined},'opaque'),false);
  for(const [status,body] of [[201,{accepted:true,reference:'old'}],[201,{ok:false,reference:'false'}],[200,{ok:true,reference:'wrong-status'}],[201,{ok:true}]]){
    await assert.rejects(sendPublicSubmission({endpoint:'https://cms.example.test/api',values,token:'opaque',fetchImpl:async()=>response(status,body)}),error=>error.type==='unconfirmed');
  }
});
test('handles duplicate, origin denial and oversized requests without fake receipts',async()=>{
  for(const [status,type] of [[409,'duplicate'],[403,'forbidden'],[413,'size'],[415,'configuration']]){
    await assert.rejects(sendPublicSubmission({endpoint:'https://cms.example.test/api',values,token:'opaque',fetchImpl:async()=>response(status,{ok:false,errors:[{message:'A backend error.'}]})}),error=>error.type===type);
  }
  await assert.rejects(sendPublicSubmission({endpoint:'https://cms.example.test/api',values:{...values,message:'\u0000'.repeat(20000)},token:'opaque',fetchImpl:()=>assert.fail('oversized JSON must not be sent')}),error=>error.type==='size');
});
