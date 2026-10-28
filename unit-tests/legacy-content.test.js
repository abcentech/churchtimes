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
const textNode=text=>({type:'text',text});
const paragraph=text=>({type:'paragraph',children:[textNode(text)]});
const article=children=>({root:{type:'root',children}});
test('full 100x20 table has an independent budget and preserves subsequent article text',()=>{
 const html=renderArticleContent(syntheticLegacyContent(50,media),{baseUrl});
 assert.equal([...html.matchAll(/<(?:td|th)(?: |>)/g)].length,2000);
 assert.match(html,/Synthetic cell 100-20/);assert.match(html,/Synthetic narrative after table 50/);
 assert.doesNotMatch(html,/Table shortened/);
});
test('oversize tables and cell contents show a visible shortening note and preserve article prose',()=>{
 for(const children of [Array.from({length:101},()=>({type:'tablerow',children:[{type:'tablecell',children:[paragraph('Cell')]}]})),[{type:'tablerow',children:Array.from({length:21},()=>({type:'tablecell',children:[paragraph('Cell')]}))}],[{type:'tablerow',children:[{type:'tablecell',children:Array.from({length:11000},()=>paragraph('Cell'))}]}]]) {
  const html=renderArticleContent(article([{type:'table',children},paragraph('After the table')]));
  assert.match(html,/Table shortened/);assert.match(html,/<p>After the table<\/p>/);
 }
});
test('h1 through h6 progress below the page h1; empty headings never advance the counter',()=>{
 const heading=(tag,text)=>({type:'heading',tag,children:[textNode(text)]});
 const html=renderArticleContent(article([heading('h6',' \u00a0 '),heading('h1','One'),heading('h6','\t'),heading('h5','Two'),heading('h6','Three'),heading('h5','Four'),heading('h6','Five')]));
 assert.equal(html,'<h2>One</h2><h3>Two</h3><h4>Three</h4><h5>Four</h5><h6>Five</h6>');
});
test('table spans cap at20, rejecting nonintegers instead of copying arbitrary attributes',()=>{
 const html=renderArticleContent(article([{type:'table',children:[{type:'tablerow',children:[{type:'tablecell',colSpan:500,rowSpan:900,children:[textNode('Cell')]}]}]}]));
 assert.match(html,/colspan="20" rowspan="20"/);
});
test('root-relative body links remain links; protocol-relative, controls and backslashes do not',()=>{
 for(const url of ['/news/x','/news/x?from=archive&n=1','/news/x#heading']) {
  assert.match(renderArticleContent(article([{type:'link',fields:{url},children:[textNode('Reference')]}])),/<a href="\/news\/x/);
 }
 for(const url of ['//evil.test/x','/\\evil.test/x','/\nevil.test/x','javascript:alert(1)']) {
  assert.equal(renderArticleContent(article([{type:'link',fields:{url},children:[textNode('Reference')]}])),'Reference');
 }
});
test('C1 youtubeEmbed contract fixture is an escaped labelled link only, never an embed or arbitrary URL',()=>{
 const block=fields=>({type:'block',version:2,fields:{blockType:'youtubeEmbed',...fields}});
 const html=renderArticleContent(article([block({videoId:'abc_DE-1234',title:'Synthetic <title> & video'})]));
 assert.equal(html,'<p><a href="https://www.youtube.com/watch?v=abc_DE-1234" rel="noopener noreferrer">Watch video on YouTube: Synthetic &lt;title&gt; &amp; video</a></p>');
 assert.doesNotMatch(html,/<iframe|<script|<img|embed\//);
 assert.match(renderArticleContent(article([block({videoId:'abc_DE-1234',title:'\u00a0'})])),/>Watch video on YouTube<\/a>/);
 for(const videoId of ['x','abc_DE-1234?evil','https://evil.test','abc<DEF1234'])assert.equal(renderArticleContent(article([block({videoId})])), '');
});
test('cumulative table budget remains separate from prose and every shortened table is labelled',()=>{
 const table=syntheticLegacyContent(50,media).root.children.find(node=>node.type==='table');
 const html=renderArticleContent(article([table,table,table,table,paragraph('Prose survives all tables')]));
 assert.match(html,/Table shortened/);assert.match(html,/Prose survives all tables/);
 assert.ok([...html.matchAll(/<(?:td|th)(?: |>)/g)].length<8000);
});
test('absolute and mailto links preserve URL-encoded spaces and trim surrounding whitespace',()=>{
 for(const [url,expected] of [['https://example.test/My File.pdf','https://example.test/My%20File.pdf'],[' https://example.test/My File.pdf ','https://example.test/My%20File.pdf'],['mailto:news@example.test?subject=Hi there','mailto:news@example.test?subject=Hi%20there']]) {
  const html=renderArticleContent(article([{type:'link',fields:{url},children:[textNode('Reference')]}]));
  assert.match(html,/<a /);assert.ok(html.includes(`href="${expected}"`));
 }
 for(const url of ['/news/My File','https://user:password@example.test/My File',' https://example.test/\n','mailto:news@example.test?subject=Hi\tthere']) {
  assert.equal(renderArticleContent(article([{type:'link',fields:{url},children:[textNode('Reference')]}])),'Reference');
 }
});
test('YouTube titles are bounded before escaping and paragraph-nested blocks stay valid inline links',()=>{
 const block={type:'block',fields:{blockType:'youtubeEmbed',videoId:'abcdefghijk',title:'<'.repeat(100000)}};
 const html=renderArticleContent(article([{type:'paragraph',children:[textNode('Video: '),block]}]));
 assert.equal(html,`<p>Video: <a href="https://www.youtube.com/watch?v=abcdefghijk" rel="noopener noreferrer">Watch video on YouTube: ${'&lt;'.repeat(200)}</a></p>`);
 assert.ok(html.length<1200);assert.doesNotMatch(html,/<p><p>/);
 const unicode=renderArticleContent(article([{...block,fields:{...block.fields,title:'a'.repeat(199)+'\ud83d\ude00'}}]));
 assert.doesNotMatch(unicode,/[\ud800-\udbff]/u);
});
