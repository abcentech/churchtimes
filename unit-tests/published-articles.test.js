import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublishedArticle, fetchPublishedPage, fetchPublishedArticle } from '../src/lib/published-articles.js';
import { renderArticleContent } from '../src/lib/article-content.js';

const report = {id:1,slug:'church-and-community',title:'Church and community',status:'published',publishedAt:'2026-10-13T08:00:00Z'};
test('accepts only published articles with usable slugs and titles', () => {
  for (const status of ['draft','in_review','changes_requested','approved',undefined]) assert.equal(normalizePublishedArticle({...report,status}),null);
  for (const slug of ['../draft','<script>','a/b','']) assert.equal(normalizePublishedArticle({...report,slug}),null);
  assert.equal(normalizePublishedArticle({...report,title:'  '}),null);
  assert.equal(normalizePublishedArticle({...report,publishedAt:'not a date'}).publishedAt,'');
  assert.equal(normalizePublishedArticle({...report,category:{title:'Features'}}).category,'Features');
});
test('requests anonymous published-only, sorted, paginated records and filters invalid responses', async () => {
  const result = await fetchPublishedPage({baseUrl:'https://cms.example.test',page:2,limit:12,fetchImpl:async (url,options) => {
    const request = new URL(url);
    assert.equal(request.searchParams.get('where[status][equals]'),'published');
    assert.equal(request.searchParams.get('sort'),'-publishedAt');
    assert.equal(request.searchParams.get('page'),'2');
    assert.equal(request.searchParams.get('limit'),'12');
    assert.equal(options.credentials,'omit');
    return {ok:true,json:async()=>({docs:[report,{...report,status:'draft'}],hasNextPage:true,nextPage:3})};
  }});
  assert.equal(result.articles.length,1);
  assert.equal(result.nextPage,3);
});
test('slug lookup filters by publication and rejects mismatched or draft results', async () => {
  const fetchImpl = async url => {
    assert.equal(new URL(url).searchParams.get('where[slug][equals]'),report.slug);
    return {ok:true,json:async()=>({docs:[{...report,slug:'wrong-story'},{...report,status:'draft'}]})};
  };
  assert.equal(await fetchPublishedArticle({baseUrl:'https://cms.example.test',slug:report.slug,fetchImpl}),null);
  assert.equal(await fetchPublishedArticle({slug:'../draft',fetchImpl:()=>assert.fail('invalid slugs must not request CMS')}),null);
});
test('rejects malformed responses and HTTP failures; aborts stalled requests', async () => {
  await assert.rejects(fetchPublishedPage({baseUrl:'javascript:alert(1)'}),/absolute HTTP/);
  await assert.rejects(fetchPublishedPage({baseUrl:'https://cms.example.test',fetchImpl:async()=>({ok:true,json:async()=>({docs:null})})}),/Unexpected/);
  await assert.rejects(fetchPublishedPage({baseUrl:'https://cms.example.test',fetchImpl:async()=>({ok:false,status:503})}),/503/);
  await assert.rejects(fetchPublishedPage({baseUrl:'https://cms.example.test',timeoutMs:5,fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))}),/aborted/);
});
const text = value => ({type:'text',text:value,format:0});
test('renders plaintext as text, never markup', () => {
  assert.equal(renderArticleContent('<script>alert(1)</script>\n\nSecond paragraph'),'<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p>Second paragraph</p>');
});
test('renders supported Lexical text and formatting while dropping embeds and unsafe links', () => {
  const content = {root:{type:'root',children:[
    {type:'heading',tag:'h1',children:[text('Community <news>')]},
    {type:'paragraph',children:[{...text('Bold'),format:1},{type:'link',fields:{url:'javascript:alert(1)'},children:[text('unsafe')]},{type:'link',fields:{url:'https://example.test/report'},children:[text('source')]}]},
    {type:'html',html:'<img onerror=alert(1)>'},
    {type:'upload',value:{url:'javascript:alert(1)'}},
    {type:'list',listType:'number',children:[{type:'listitem',children:[text('First')]}]},
  ]}};
  const html = renderArticleContent(content);
  assert.match(html,/<h2>Community &lt;news&gt;<\/h2>/);
  assert.match(html,/<strong>Bold<\/strong>unsafe<a href="https:\/\/example.test\/report"/);
  assert.match(html,/<ol><li>First<\/li><\/ol>/);
  assert.doesNotMatch(html,/javascript|onerror|<img|<h1>/);
});
test('bounds deeply nested rich text and handles missing content', () => {
  let node = text('deep');
  for(let i=0;i<100;i++) node={type:'paragraph',children:[node]};
  assert.equal(renderArticleContent({root:{type:'root',children:[node]}}),'');
  assert.equal(renderArticleContent(null),'');
});

test('navigation cancellation aborts the public request without changing its contract', async () => {
  const controller = new AbortController();
  const result = fetchPublishedPage({baseUrl:'https://cms.example.test',signal:controller.signal,fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('navigation aborted'))))});
  controller.abort();
  await assert.rejects(result,error=>error.type==='cancelled');
});

test('actual public fields map byline, media and correction history without private author data',()=>{
  const normalized=normalizePublishedArticle({...report,bylineName:'Public byline',author:{name:'Private user'},category:{id:1,title:'News'},featuredImage:{id:2,url:'/api/media/file/photo.webp',mimeType:'image/webp',width:800,height:450,alt:'Community meeting',credit:'Publication'},corrections:[{note:'Corrected location.',correctedAt:'2026-10-13T09:00:00Z'}]},{baseUrl:'https://cms.example.test'});
  assert.equal(normalized.bylineName,'Public byline');assert.equal(normalized.author,undefined);
  assert.equal(normalized.featuredImage.url,'https://cms.example.test/api/media/file/photo.webp');
  assert.equal(normalized.category,'News');assert.equal(normalized.corrections[0].note,'Corrected location.');
});
test('safe Lexical media and formatting render; unsafe uploads and links remain excluded',()=>{
  const media={url:'/api/media/file/photo.webp',mimeType:'image/webp',width:800,height:450,alt:'Community photo',caption:'<script>caption</script>'};
  const html=renderArticleContent({root:{type:'root',children:[{type:'upload',relationTo:'media',value:media},{type:'paragraph',children:[{type:'text',text:'Formatted',format:8|16}]}]}},{baseUrl:'https://cms.example.test'});
  assert.match(html,/https:\/\/cms.example.test\/api\/media\/file\/photo.webp/);assert.match(html,/&lt;script&gt;caption/);assert.match(html,/<code><u>Formatted<\/u><\/code>/);
  for(const url of ['javascript:alert(1)','data:image/svg+xml,evil','//evil.test/image','https://user:pass@evil.test/image'])assert.equal(renderArticleContent({root:{type:'root',children:[{type:'upload',relationTo:'media',value:{...media,url}}]}},{baseUrl:'https://cms.example.test'}),'');
});
test('CMS timeout, malformed JSON and permission errors stay distinguishable',async()=>{
  await assert.rejects(fetchPublishedPage({baseUrl:'https://cms.example.test',fetchImpl:async()=>({ok:true,json:async()=>{throw new SyntaxError('HTML response');}})}),e=>e.type==='response');
  await assert.rejects(fetchPublishedPage({baseUrl:'https://cms.example.test',fetchImpl:async()=>({ok:false,status:403})}),e=>e.type==='http'&&e.status===403);
  await assert.rejects(fetchPublishedPage({baseUrl:'https://cms.example.test',timeoutMs:5,fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))}),e=>e.type==='timeout');
});

test('maps public byline, corrections, legacy URL and CMS-relative media without staff data',()=>{
  const value=normalizePublishedArticle({...report,bylineName:'A public byline',author:{email:'private@example.test'},reviewNotes:'private',legacyUrl:'https://churchtimesnigeria.net/original/',corrections:[{note:'A correction.',correctedAt:'2026-10-13T10:00:00Z'}],featuredImage:{url:'/api/media/file/photo.jpg',alt:'Photograph',mimeType:'image/jpeg',width:640,height:480,sizes:{card:{url:'/api/media/file/photo-card.jpg'}}}},{baseUrl:'https://cms.example.test'});
  assert.equal(value.bylineName,'A public byline');assert.equal(value.featuredImage.url,'https://cms.example.test/api/media/file/photo.jpg');
  assert.equal(value.featuredImage.cardUrl,'https://cms.example.test/api/media/file/photo-card.jpg');assert.equal(value.corrections[0].note,'A correction.');
  assert.equal(value.legacyUrl,'https://churchtimesnigeria.net/original/');assert.equal('author' in value,false);assert.equal('reviewNotes' in value,false);
});
test('rejects unsafe media URLs, unsupported MIME types and unrelated legacy destinations',()=>{
  for(const featuredImage of [{url:'javascript:alert(1)'},{url:'https://foreign.test/api/media/file/photo.jpg'},{url:'/admin/private'},{url:'/api/media/file/photo.svg',mimeType:'image/svg+xml'}]){
    assert.equal(normalizePublishedArticle({...report,featuredImage},{baseUrl:'https://cms.example.test'}).featuredImage,null);
  }
  assert.equal(normalizePublishedArticle({...report,legacyUrl:'https://foreign.test/'}).legacyUrl,'');
});
test('renders populated Lexical media safely and never resolves private/unpopulated upload IDs',()=>{
  const make=value=>({root:{type:'root',children:[{type:'upload',relationTo:'media',value}]}});
  const html=renderArticleContent(make({url:'/api/media/file/photo.jpg',mimeType:'image/jpeg',alt:'<script>unsafe</script>',caption:'<img onerror=alert(1)>',width:640,height:480}),{baseUrl:'https://cms.example.test'});
  assert.match(html,/src="https:\/\/cms.example.test\/api\/media\/file\/photo.jpg"/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img onerror/);
  assert.equal(renderArticleContent(make(123),{baseUrl:'https://cms.example.test'}),'');
});

test('category pagination resolves numeric IDs and search filters always require published records',async()=>{
  const {fetchPublicCategories}=await import('../src/lib/published-articles.js');
  const categories=await fetchPublicCategories({baseUrl:'https://cms.example.test',fetchImpl:async url=>({ok:true,json:async()=>new URL(url).searchParams.get('page')==='1'?{docs:[{id:7,slug:'news',title:'News'},{id:'8',slug:'bad',title:'Invalid ID'}],hasNextPage:true,nextPage:2}:{docs:[{id:7,slug:'news',title:'News'},{id:9,slug:'features',title:'Features'}]}})});
  assert.deepEqual(categories.map(c=>c.id),[7,9]);
  await fetchPublishedPage({baseUrl:'https://cms.example.test',categoryIds:categories.map(c=>c.id),query:'education',fetchImpl:async url=>{
    const q=new URL(url).searchParams;assert.equal(q.get('where[category][in]'),'7,9');assert.equal(q.get('where[status][equals]'),'published');
    for(const [index,field] of ['title','excerpt','bylineName'].entries())assert.equal(q.get(`where[or][${index}][${field}][like]`),'education');
    return {ok:true,json:async()=>({docs:[]})};
  }});
  await assert.rejects(fetchPublishedPage({baseUrl:'https://cms.example.test',categoryIds:['news'],fetchImpl:()=>assert.fail('must resolve IDs before calling CMS')}),/numeric IDs/);
  for(const baseUrl of ['http://remote.test','https://user:password@cms.test','https://cms.test/admin'])await assert.rejects(fetchPublishedPage({baseUrl}));
  assert.equal(normalizePublishedArticle({...report,slug:'a'.repeat(161)}),null);
});
