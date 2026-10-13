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
  await assert.rejects(result,/navigation aborted/);
});
