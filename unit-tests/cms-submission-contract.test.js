// Exercise the merged server handler unchanged. Persistence and Siteverify are test doubles;
// this is a contract test, not a deployed database or live Cloudflare integration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendPublicSubmission } from '../src/lib/public-submissions.js';
import { renderArticleContent } from '../src/lib/article-content.js';

registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('.') && context.parentURL?.includes('/apps/cms/')){
    const candidate=new URL(`${specifier}.ts`,context.parentURL);
    if(existsSync(fileURLToPath(candidate)))return next(candidate.href,context);
  }
  return next(specifier,context);
}});
process.env.NODE_ENV='test';
process.env.TURNSTILE_SECRET_KEY='1x0000000000000000000000000000000AA'; // Official, public test key.
process.env.TURNSTILE_ALLOWED_HOSTNAMES='localhost';
process.env.TURNSTILE_EXPECTED_ACTION='public_story';
const {publicSubmissionsEndpoint,resetPublicSubmissionLimiters}=await import('../apps/cms/src/endpoints/publicSubmissions.ts');
const {setTurnstileFetchForTests}=await import('../apps/cms/src/lib/turnstile.ts');
const {paragraphsToLexical}=await import('../apps/cms/src/seed/lexical.ts');
const values={name:'A reader',email:'reader@example.test',phone:'+234 803 123 4567',title:'A community story',message:'The key facts and source links for the newsroom.',category:'News',location:'Lagos',consent:true};

function transport({rejectVerification=false,duplicate=false}={}){
  resetPublicSubmissionLimiters();
  setTurnstileFetchForTests(async()=>Response.json({success:!rejectVerification,hostname:'localhost',action:'public_story'}));
  const stored=[];
  const fetchImpl=async(endpoint,options)=>{
    const request=new Request(endpoint,options);
    request.payload={logger:{warn(){},error(){}},find:async()=>({docs:duplicate?[{id:1}]:[]}),create:async({collection,data})=>{
      if(collection==='submissions')stored.push(data);
      return {id:stored.length,...data};
    }};
    return publicSubmissionsEndpoint.handler(request);
  };
  return {fetchImpl,stored};
}

test('frontend payload reaches the real CMS handler and reads its generated receipt',async()=>{
  const {fetchImpl,stored}=transport();
  const receipt=await sendPublicSubmission({endpoint:'https://cms.example.test/api/public/submissions',values,token:'test-token',fetchImpl});
  assert.match(receipt.reference,/^SUB-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  assert.equal(stored.length,1);
  assert.equal(stored[0].categorySuggestion,'News');
  assert.equal(stored[0].location,'Lagos');
  assert.equal(stored[0].status,'new');
  assert.equal(stored[0].reference,receipt.reference);
  assert.equal(stored[0].category,undefined);
});
test('real CMS duplicate and Turnstile errors do not generate success or auto-retry',async()=>{
  for(const [options,type] of [[{duplicate:true},'duplicate'],[{rejectVerification:true},'challenge']]){
    const {fetchImpl,stored}=transport(options);
    let calls=0;
    await assert.rejects(sendPublicSubmission({endpoint:'https://cms.example.test/api/public/submissions',values,token:'test-token',fetchImpl:(...args)=>{calls++;return fetchImpl(...args);}}),error=>error.type===type);
    assert.equal(calls,1);assert.equal(stored.length,0);
  }
});
test('real CMS field-error array maps back to the input without echoing server messages',async()=>{
  const {fetchImpl}=transport();
  // The CMS strips markup; a name consisting only of markup becomes empty server-side.
  await assert.rejects(sendPublicSubmission({endpoint:'https://cms.example.test/api/public/submissions',values:{...values,name:'<b></b>'},token:'test-token',fetchImpl}),error=>error.type==='validation'&&error.fields.name==='Please check this field and try again.');
});
test('actual CMS seed Lexical content renders its paragraphs safely',()=>{
  assert.equal(renderArticleContent(paragraphsToLexical(['A published report.','<script>unsafe</script>'])), '<p>A published report.</p><p>&lt;script&gt;unsafe&lt;/script&gt;</p>');
});
