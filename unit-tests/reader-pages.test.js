// Reader trust furniture (W12 A): normalisation, article furniture, pull quote/gallery blocks, author and trust pages.
// All CMS data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {normalizePublishedArticle} from '../src/lib/published-articles.js';
import {renderArticleContent} from '../src/lib/article-content.js';
import {readingMinutes,countWords,metaHTML,keyPointsHTML,eyebrowHTML,disclosureHTML,bylineHTML,kickerHTML,cardLabel,showUpdated} from '../src/lib/reader-article.js';
import {publicPageRoute} from '../src/lib/public-page-routes.js';
import {articleSchema} from '../src/lib/public-routes.js';
import {renderReaderPage,normalizeAuthorPage,normalizeCorrectionsLog,readerPageKey} from '../src/lib/reader-pages.js';
import {createPublicServer} from '../tools/serve-public.mjs';

const CMS='https://cms.example.test';
const paragraph=text=>({type:'paragraph',children:[{type:'text',text}]});
const words=n=>Array.from({length:n},(_,i)=>'word'+i).join(' ');
const record=(extra={})=>({id:7,slug:'synod-report',title:'Synod report',status:'published',excerpt:'Synthetic excerpt.',publishedAt:'2026-10-20T08:00:00Z',category:{title:'News',slug:'news'},bylineName:'Fallback byline',corrections:[],content:{root:{type:'root',children:[paragraph(words(450))]}},...extra});
const profile={id:3,name:'Ada Okafor',slug:'ada-okafor',role:'Senior Correspondent',isPublic:true};
const media=(name,extra={})=>({id:name.length,url:`/api/media/file/${name}.jpg`,mimeType:'image/jpeg',width:1200,height:800,alt:`Alt for ${name}`,caption:`Library caption ${name}`,...extra});

test('new article fields are normalised defensively; private staff authors never surface',()=>{
  const a=normalizePublishedArticle(record({kicker:'  Exclusive  ',contentType:'opinion',keyPoints:[{text:'One'},{text:''},{text:'Two'},{text:'3'},{text:'4'},{text:'5'},{text:'6'}],lastSubstantiveUpdate:'2026-10-21T09:30:00Z',bylineAuthor:profile,author:{email:'staff@example.test'}}),{baseUrl:CMS});
  assert.equal(a.kicker,'Exclusive');assert.equal(a.contentType,'opinion');
  assert.deepEqual(a.keyPoints,['One','Two','3','4']);
  assert.equal(a.lastSubstantiveUpdate,'2026-10-21T09:30:00.000Z');
  assert.deepEqual(a.bylineProfile,{name:'Ada Okafor',slug:'ada-okafor'});
  assert.equal('author' in a,false);
  const legacy=normalizePublishedArticle(record({contentType:null,bylineAuthor:3,keyPoints:null}));
  assert.equal(legacy.contentType,'news');assert.equal(legacy.bylineProfile,null);assert.deepEqual(legacy.keyPoints,[]);
  assert.equal(normalizePublishedArticle(record({contentType:'advert',bylineAuthor:{...profile,isPublic:false}})).contentType,'news');
  assert.equal(normalizePublishedArticle(record({bylineAuthor:{...profile,isPublic:false}})).bylineProfile,null);
  assert.equal(normalizePublishedArticle(record({bylineAuthor:{...profile,slug:'../x'}})).bylineProfile,null);
});

test('reading time counts body words only (220 a minute, at least one)',()=>{
  assert.equal(readingMinutes({root:{children:[paragraph(words(450))]}}),2);
  assert.equal(readingMinutes({root:{children:[paragraph('short')]}}),1);
  assert.equal(readingMinutes(null),1);
  assert.equal(readingMinutes(words(1100)),5);
  assert.equal(countWords({root:{children:[paragraph('a b c'),{type:'block',fields:{blockType:'pullQuote',quote:'d e f g'}}]}}),3);
});

test('labels, kicker, disclosure, byline link, Updated stamp and key points are escaped and honest',()=>{
  const a=normalizePublishedArticle(record({kicker:'<b>Exclusive</b>',contentType:'sponsored',keyPoints:[{text:'<img src=x>'}],lastSubstantiveUpdate:'2026-10-22T10:00:00Z',bylineAuthor:profile}));
  assert.match(eyebrowHTML(a),/<span class="reader-type" data-type="sponsored">Sponsored<\/span>.*News/);
  assert.equal(kickerHTML(a),'<p class="reader-kicker">&lt;b&gt;Exclusive&lt;/b&gt;</p>');
  assert.match(disclosureHTML(a),/Sponsored content: paid for by a commercial partner\./);
  assert.equal(disclosureHTML({contentType:'news'}),'');
  assert.match(bylineHTML(a,{base:'/edition/'}),/By <a href="\/edition\/author\/ada-okafor\/" rel="author">Ada Okafor<\/a>/);
  assert.match(bylineHTML({bylineName:'<i>Desk</i>'}),/By &lt;i&gt;Desk&lt;\/i&gt;/);
  const meta=metaHTML(a);
  assert.match(meta,/Updated <time datetime="2026-10-22T10:00:00.000Z">22 October 2026<\/time>/);
  assert.match(meta,/2 min read/);
  assert.match(keyPointsHTML(a),/<h2 id="reader-keypoints-title">What you need to know<\/h2><ul><li>&lt;img src=x&gt;<\/li><\/ul>/);
  assert.equal(keyPointsHTML({keyPoints:[]}),'');
  assert.equal(showUpdated({publishedAt:'2026-10-22T10:00:00Z',lastSubstantiveUpdate:'2026-10-21T10:00:00Z'}),false);
  assert.doesNotMatch(metaHTML({...a,lastSubstantiveUpdate:''}),/Updated/);
  assert.equal(cardLabel({contentType:'news'}),'');assert.equal(cardLabel({contentType:'factcheck'}),'Fact-check');
});

test('pull quotes and galleries render as text with public media only',()=>{
  const html=renderArticleContent({root:{type:'root',children:[
    {type:'block',fields:{blockType:'pullQuote',quote:'<script>We will rebuild</script>',attribution:'Archbishop <A>'}},
    {type:'block',fields:{blockType:'pullQuote',quote:'   '}},
    {type:'block',fields:{blockType:'gallery',images:[{image:media('choir'),caption:'The choir at dawn'},{image:media('nave'),caption:''},{image:12,caption:'unpopulated'},{image:media('evil',{url:'https://evil.test/api/media/file/x.jpg'})},{image:media('svg',{mimeType:'image/svg+xml'})}]}},
    {type:'paragraph',children:[{type:'block',fields:{blockType:'pullQuote',quote:'nested'}}]},
  ]}},{baseUrl:CMS});
  assert.match(html,/<figure class="reader-pullquote"><blockquote><p>&lt;script&gt;We will rebuild&lt;\/script&gt;<\/p><\/blockquote><figcaption>Archbishop &lt;A&gt;<\/figcaption><\/figure>/);
  assert.equal((html.match(/reader-pullquote/g)||[]).length,1);
  assert.match(html,/<section class="reader-gallery" aria-label="Gallery: 2 photos">/);
  assert.match(html,/alt="Alt for choir"/);assert.match(html,/The choir at dawn/);
  assert.match(html,/Library caption nave/,'an empty row caption falls back to the media caption');
  assert.doesNotMatch(html,/evil\.test|unpopulated|svg|nested/);
  const many=renderArticleContent({root:{type:'root',children:[{type:'block',fields:{blockType:'gallery',images:Array.from({length:20},(_,i)=>({image:media('p'+i)}))}}]}},{baseUrl:CMS});
  assert.equal((many.match(/<li>/g)||[]).length,12);
});

test('NewsArticle schema links a public author profile and uses the editor-set Updated date',()=>{
  const a=normalizePublishedArticle(record({bylineAuthor:profile,lastSubstantiveUpdate:'2026-10-22T10:00:00Z'}));
  const flat=articleSchema(a,'https://public.example.test/synod-report/');
  assert.deepEqual(flat.author,{'@type':'Person',name:'Ada Okafor',url:'https://public.example.test/author/ada-okafor/'});
  assert.equal(flat.dateModified,'2026-10-22T10:00:00.000Z');
  assert.equal(articleSchema(a,'https://public.example.test/edition/reports/synod-report/').author.url,'https://public.example.test/edition/author/ada-okafor/');
  assert.deepEqual(articleSchema(normalizePublishedArticle(record()),'').author,{'@type':'Person',name:'Fallback byline'});
});

test('reader routes and keys',()=>{
  assert.deepEqual(publicPageRoute('/author/ada-okafor/'),['author','ada-okafor']);
  assert.deepEqual(publicPageRoute('/about/editorial-standards/'),['trust','editorial-standards']);
  assert.deepEqual(publicPageRoute('/about/ownership'),['trust','ownership']);
  assert.deepEqual(publicPageRoute('/corrections/'),['corrections']);
  for(const path of ['/author/Bad_Slug/','/author/a/b/','/about/other/','/corrections/x/'])assert.equal(publicPageRoute(path),null,path);
  assert.equal(readerPageKey('trust','corrections'),'');assert.equal(readerPageKey('author','x'),'author');assert.equal(readerPageKey('trust','ownership'),'ownership');
});

test('author pages keep only safe socials and render escaped profile data with Person JSON-LD',()=>{
  const author=normalizeAuthorPage({author:{...profile,bio:'Line one <b>\n\nParagraph two',avatar:{url:'/api/media/file/ada.jpg',thumbnailUrl:'/api/media/file/ada-400.jpg'},socials:[{kind:'x',url:'https://x.com/ada'},{kind:'website',url:'javascript:alert(1)'},{kind:'bogus',url:'https://example.test/'}]},articles:[record({contentType:'analysis'})],page:1,hasNextPage:true},{baseUrl:CMS});
  assert.equal(author.avatar,`${CMS}/api/media/file/ada-400.jpg`);
  assert.deepEqual(author.socials,[{kind:'x',url:'https://x.com/ada'},{kind:'website',url:'https://example.test/'}]);
  const view=renderReaderPage('author',{author},{base:'/',articleHref:slug=>`/${slug}/`,canonical:path=>'https://public.example.test'+path});
  assert.match(view.html,/<h1>Ada Okafor<\/h1>/);assert.match(view.html,/Line one &lt;b&gt;/);assert.match(view.html,/<p>Paragraph two<\/p>/);
  assert.match(view.html,/rel="me noopener noreferrer"/);assert.match(view.html,/Analysis · News/);
  assert.match(view.html,/href="\/author\/ada-okafor\/\?page=2" rel="next"/);
  const [page,crumbs]=view.schema['@graph'];
  assert.equal(page['@type'],'ProfilePage');assert.equal(page.mainEntity.jobTitle,'Senior Correspondent');assert.deepEqual(page.mainEntity.sameAs,['https://x.com/ada','https://example.test/']);
  assert.equal(crumbs.itemListElement[1].item,'https://public.example.test/author/ada-okafor/');
  assert.equal(normalizeAuthorPage({author:{...profile,isPublic:false}}),null);
});

test('the corrections log keeps published articles with real notes, newest first as sent',()=>{
  const log=normalizeCorrectionsLog({docs:[{article:record(),corrections:[{note:'Corrected the date.',correctedAt:'2026-10-25T08:00:00Z'},{note:''}]},{article:{...record(),status:'draft'},corrections:[{note:'x'}]},{article:record({slug:'other'}),corrections:[]}],page:1,hasNextPage:false});
  assert.equal(log.docs.length,1);assert.deepEqual(log.docs[0].corrections,[{note:'Corrected the date.',correctedAt:'2026-10-25T08:00:00.000Z'}]);
  const view=renderReaderPage('corrections',{trust:null,log},{articleHref:slug=>`/${slug}/`});
  assert.match(view.html,/<h1>Corrections<\/h1>/);assert.match(view.html,/Corrected the date\./);assert.match(view.html,/25 October 2026/);
  assert.match(renderReaderPage('corrections',{trust:null,log:{docs:[],page:1,hasNextPage:false}},{articleHref:s=>s}).html,/No corrections have been published\./);
});

// Public host: server-rendered pages with a synthetic CMS.
const lexical=text=>({root:{type:'root',children:[{type:'heading',tag:'h2',children:[{type:'text',text:'Accuracy'}]},paragraph(text)]}});
async function host(t,routes) {
  const dist=await mkdtemp(join(tmpdir(),'public-reader-'));
  await writeFile(join(dist,'index.html'),await readFile(new URL('../src/index.template.html',import.meta.url),'utf8'));
  await mkdir(join(dist,'assets'));await writeFile(join(dist,'assets','reader-pages-abc123.css'),'.reader-keypoints{margin:0}');await writeFile(join(dist,'assets','index-x.css'),'body{margin:0}');
  const calls=[];
  const fetchImpl=async url=>{
    const u=new URL(url);calls.push(u.pathname+u.search);
    for(const [prefix,value] of Object.entries(routes))if((u.pathname+u.search).startsWith(prefix)){if(value instanceof Error)throw value;return value===404?new Response('{}',{status:404}):Response.json(value);}
    return Response.json({docs:[]});
  };
  const server=createPublicServer({dist,cmsUrl:CMS,siteUrl:'https://public.example.test',indexable:true,fetchImpl});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dist,{recursive:true,force:true});});
  return {origin:'http://127.0.0.1:'+server.address().port,calls};
}
const trust={editorialStandards:lexical('We verify before we publish.'),ownershipFunding:null,ethicsCorrectionsPolicy:lexical('We correct errors openly.'),contactEditors:'Write to the editors <here>.'};

test('author pages are server-rendered, readable without JavaScript, with embedded data and JSON-LD',async t=>{
  const {origin,calls}=await host(t,{'/api/public/authors/ada-okafor':{author:{...profile,bio:'Reports on faith and public life.',socials:[]},articles:[record({bylineAuthor:profile})],page:1,hasNextPage:false},'/api/public/authors/nobody':404});
  const res=await fetch(origin+'/author/ada-okafor/');const html=await res.text();
  assert.equal(res.status,200);assert.equal(res.headers.get('x-robots-tag'),'index,follow');
  assert.match(html,/<h1>Ada Okafor<\/h1>/);assert.match(html,/Reports on faith and public life\./);
  assert.match(html,/<a href="\/synod-report\/">Synod report<\/a>/);
  assert.match(html,/<link rel="canonical" href="https:\/\/public\.example\.test\/author\/ada-okafor\/">/);
  assert.match(html,/<script id="public-reader-page" type="application\/json">/);
  assert.match(html,/"@type":"ProfilePage"/);assert.match(html,/property="og:type" content="profile"/);assert.doesNotMatch(html,/word449/,"listings never embed article bodies");
  assert.match(html,/<link rel="stylesheet" href="assets\/reader-pages-abc123\.css">/);
  assert.ok(calls.includes('/api/public/authors/ada-okafor?page=1'));
  assert.equal((await fetch(origin+'/author/nobody/')).status,404);
  assert.equal((await fetch(origin+'/author/ada-okafor',{redirect:'manual'})).status,308);
  const second=await fetch(origin+'/author/ada-okafor/?page=2');assert.equal(second.headers.get('x-robots-tag'),'noindex,nofollow');
});

test('trust pages render published CMS policy; unpublished pages are 404 and the corrections log always answers',async t=>{
  const {origin}=await host(t,{'/api/public/site-trust':trust,'/api/public/corrections':{docs:[{article:record(),corrections:[{note:'Corrected the venue.',correctedAt:'2026-10-25T08:00:00Z'}]}],page:1,hasNextPage:false}});
  const standards=await fetch(origin+'/about/editorial-standards/');const html=await standards.text();
  assert.equal(standards.status,200);assert.match(html,/<h1>Editorial standards<\/h1>/);assert.match(html,/We verify before we publish\./);
  assert.match(html,/Write to the editors &lt;here&gt;\./);assert.match(html,/"publishingPrinciples":"https:\/\/public\.example\.test\/about\/editorial-standards\/"/);
  assert.doesNotMatch(html,/href="\/about\/ownership\/"/,'unpublished trust pages are not linked');
  assert.equal((await fetch(origin+'/about/ownership/')).status,404);
  const corrections=await (await fetch(origin+'/corrections/')).text();
  assert.match(corrections,/We correct errors openly\./);assert.match(corrections,/Corrected the venue\./);assert.match(corrections,/<a href="\/synod-report\/">Synod report<\/a>/);
  const none=await host(t,{'/api/public/site-trust':404,'/api/public/corrections':{docs:[],page:1,hasNextPage:false}});
  assert.equal((await fetch(none.origin+'/about/editorial-standards/')).status,404);
  const empty=await fetch(none.origin+'/corrections/');assert.equal(empty.status,200);assert.match(await empty.text(),/No corrections have been published\./);
  const down=await host(t,{'/api/public/site-trust':new Error('down')});
  const failed=await fetch(down.origin+'/corrections/');assert.equal(failed.status,503);assert.equal(failed.headers.get('retry-after'),'60');
});

test('server-rendered articles carry labels, the Updated stamp, reading time, key points and the byline link',async t=>{
  const article=record({contentType:'analysis',kicker:'Synod 2026',keyPoints:[{text:'Bishops agreed a timetable.'}],lastSubstantiveUpdate:'2026-10-22T10:00:00Z',bylineAuthor:profile,content:{root:{type:'root',children:[paragraph(words(30)),{type:'block',fields:{blockType:'pullQuote',quote:'We will rebuild.',attribution:'A bishop'}}]}}});
  const {origin}=await host(t,{'/api/articles':{docs:[article],hasNextPage:false}});
  const html=await (await fetch(origin+'/synod-report/')).text();
  assert.match(html,/data-type="analysis">Analysis<\/span>/);assert.match(html,/<p class="reader-kicker">Synod 2026<\/p>/);
  assert.match(html,/Updated <time datetime="2026-10-22T10:00:00.000Z">/);assert.match(html,/1 min read/);
  assert.match(html,/What you need to know/);assert.match(html,/Bishops agreed a timetable\./);
  assert.match(html,/href="\/author\/ada-okafor\/" rel="author"/);assert.match(html,/reader-pullquote/);
  assert.match(html,/<link rel="stylesheet" href="assets\/reader-pages-abc123\.css">/);
  assert.match(html,/"dateModified":"2026-10-22T10:00:00.000Z"/);
});

test('the sitemap lists the corrections page, published trust pages and public authors',async t=>{
  const {origin}=await host(t,{'/api/public/site-trust':trust,'/api/public/authors':{docs:[{id:3,name:'Ada Okafor',slug:'ada-okafor'},{id:4,slug:'no-name'}]},'/api/articles':{docs:[],totalPages:1,hasNextPage:false},'/api/categories':{docs:[],hasNextPage:false}});
  const xml=await (await fetch(origin+'/sitemap.xml')).text();
  for(const path of ['corrections/','about/editorial-standards/','author/ada-okafor/'])assert.match(xml,new RegExp(`<loc>https://public\\.example\\.test/${path}</loc>`),path);
  assert.doesNotMatch(xml,/about\/ownership|no-name/);
});
