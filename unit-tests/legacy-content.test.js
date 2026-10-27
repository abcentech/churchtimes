import test from 'node:test';import assert from 'node:assert/strict';
import {renderArticleContent} from '../src/lib/article-content.js';
import {syntheticLegacyContent,LEGACY_SAMPLE_COUNT} from '../tools/legacy-content-fixtures.mjs';
const baseUrl='https://cms.example.test';
const media={url:'/api/media/file/synthetic.png',mimeType:'image/png',width:1200,height:900,alt:'Synthetic geometric media',caption:'Synthetic <caption> & credit',credit:'Synthetic fixture'};
test('50 synthetic standard Lexical samples preserve text, accessible tables, links and captions',()=>{
 for(let i=1;i<=LEGACY_SAMPLE_COUNT;i++) {
  const html=renderArticleContent(syntheticLegacyContent(i,media),{baseUrl});
  assert.match(html,/Synthetic archived narrative/);assert.match(html,/<table><tbody>/);assert.match(html,/<th scope="col">/);assert.match(html,/<th scope="row">/);assert.match(html,/tabindex="0" role="region"/);assert.match(html,/<blockquote>/);assert.match(html,/<(?:ul|ol)>/);assert.match(html,/https:\/\/example.test\/reference-/);assert.match(html,/&lt;caption&gt; &amp; credit/);
  assert.doesNotMatch(html,/<script|javascript:|<iframe|wp-content/);
 }
});
test('tables drop arbitrary attributes and bound spans, malformed rows and hostile nesting',()=>{
 const cell={type:'tablecell',headerState:1,colSpan:500,rowSpan:'2" onclick="x',style:'color:red',children:[{type:'text',text:'<unsafe>'}]};
 const content={root:{type:'root',children:[{type:'table',children:[null,{type:'html',html:'unsafe'},{type:'tablerow',children:[cell,{...cell,colSpan:2,rowSpan:3,headerState:2}]}]}]}};
 const html=renderArticleContent(content);
 assert.match(html,/colspan="2" rowspan="3"/);assert.match(html,/&lt;unsafe&gt;/);assert.doesNotMatch(html,/onclick|style=|500|<unsafe>/);
 assert.equal(renderArticleContent({root:{type:'root',children:[{type:'table',children:[]}]}}),'');
 let nested={type:'text',text:'bounded'};for(let i=0;i<40;i++)nested={type:'table',children:[{type:'tablerow',children:[{type:'tablecell',children:[nested]}]}]};
 const bounded=renderArticleContent({root:{type:'root',children:[nested]}});assert.doesNotMatch(bounded,/bounded/);
});
test('legacy groundwork preserves media policy and rejects credential-bearing links',()=>{
 const content=syntheticLegacyContent(1,{...media,url:'https://legacy.example.test/wp-content/uploads/private.png'});
 const html=renderArticleContent(content,{baseUrl});assert.doesNotMatch(html,/<img/);
 const credential={root:{type:'root',children:[{type:'link',fields:{url:'https://name:password@example.test/'},children:[{type:'text',text:'Reference'}]}]}};
 assert.equal(renderArticleContent(credential),'Reference');
});
test('article headings cannot skip levels below the page headline',()=>{
 const headings=['h4','h4','h4','h2'].map(tag=>({type:'heading',tag,children:[{type:'text',text:'Synthetic heading'}]}));
 assert.deepEqual([...renderArticleContent({root:{type:'root',children:headings}}).matchAll(/<(h[2-4])>/g)].map(match=>match[1]),['h2','h3','h4','h2']);
});
