import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readFollows,toggleFollow,isFollowing,normalizeFollows,rememberSearch,readRecentSearches,clearRecentSearches,whatsappDismissed,FOLLOW_KEY,FOLLOW_LIMIT,RECENT_SEARCH_LIMIT,FOLLOW_FEED_CACHE_KEY,WHATSAPP_DISMISS_KEY} from '../src/features/growth/storage.js';
import {queryTerms,highlightSegments} from '../src/features/growth/highlight.js';
import {normalizeTopicPayload,normalizeAuthorPayload,fetchTaxonomy,fetchTopicIndex} from '../src/features/growth/taxonomy-api.js';
import {mergeFollowedArticles,loadFollowingFeed} from '../src/features/growth/following-feed.js';
import {shouldSuggest,SUGGEST_MIN_CHARS} from '../src/features/growth/search-suggest.js';
import {yearOptions,FIRST_ARCHIVE_YEAR} from '../src/features/growth/search-page.js';
import {searchArticles} from '../src/lib/public-search.js';
import {topicRoute,topicSchema} from '../tools/public-routes/topic-pages.mjs';
import {createPublicServer} from '../tools/serve-public.mjs';

const memoryStorage=()=>{const map=new Map();return {getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),map};};
const throwingStorage={getItem(){throw new Error('denied');},setItem(){throw new Error('quota');},removeItem(){throw new Error('denied');}};
const origin='https://cms.example.test';

test('follows: validated, de-duplicated, capped, toggled and robust to blocked storage',()=>{
  const storage=memoryStorage();
  assert.deepEqual(readFollows(storage),[]);
  assert.deepEqual(toggleFollow({kind:'topic',slug:'youth-ministry',name:'  Youth   ministry '},storage),{following:true,saved:true});
  assert.equal(isFollowing('topic','youth-ministry',storage),true);
  assert.deepEqual(readFollows(storage),[{kind:'topic',slug:'youth-ministry',name:'Youth ministry'}]);
  toggleFollow({kind:'author',slug:'ada-obi',name:'Ada Obi'},storage);
  assert.equal(readFollows(storage)[0].slug,'ada-obi','most recent first');
  assert.deepEqual(toggleFollow({kind:'topic',slug:'youth-ministry',name:'x'},storage),{following:false,saved:true});
  assert.deepEqual(toggleFollow({kind:'topic',slug:'Bad Slug!',name:'x'},storage),{following:false,saved:false});
  assert.deepEqual(toggleFollow({kind:'church',slug:'x',name:'x'},storage),{following:false,saved:false});
  storage.setItem(FOLLOW_FEED_CACHE_KEY,'{"key":"x"}');toggleFollow({kind:'author',slug:'ada-obi'},storage);
  assert.equal(storage.getItem(FOLLOW_KEY),null,'empty list removes the key');assert.equal(storage.getItem(FOLLOW_FEED_CACHE_KEY),null,'and the cached feed');
  storage.setItem(FOLLOW_KEY,'not json');assert.deepEqual(readFollows(storage),[]);
  const many=Array.from({length:FOLLOW_LIMIT+10},(_,i)=>({kind:'topic',slug:'t'+i,name:'<b>T</b>'}));
  assert.equal(normalizeFollows([...many,many[0],{kind:'topic',slug:'__proto__'}]).length,FOLLOW_LIMIT);
  assert.deepEqual(readFollows(throwingStorage),[]);
  assert.deepEqual(toggleFollow({kind:'topic',slug:'faith',name:'Faith'},throwingStorage),{following:true,saved:false});
});

test('recent searches: newest first, case-insensitive de-dup, capped, clearable',()=>{
  const storage=memoryStorage();
  for(let i=0;i<RECENT_SEARCH_LIMIT+3;i++)rememberSearch('query '+i,storage);
  rememberSearch('  QUERY   5 ',storage);
  const recent=readRecentSearches(storage);
  assert.equal(recent.length,RECENT_SEARCH_LIMIT);assert.equal(recent[0],'QUERY 5');assert.equal(recent.filter(q=>q.toLowerCase()==='query 5').length,1);
  rememberSearch('   ',storage);assert.equal(readRecentSearches(storage)[0],'QUERY 5');
  clearRecentSearches(storage);assert.deepEqual(readRecentSearches(storage),[]);
  assert.deepEqual(rememberSearch('faith',throwingStorage),['faith']);
  assert.equal(whatsappDismissed(storage),false);storage.setItem(WHATSAPP_DISMISS_KEY,'{"reason":"dismissed"}');assert.equal(whatsappDismissed(storage),true);
});

test('highlighting: plain-text segments only, operators ignored, word-start matches',()=>{
  assert.deepEqual(queryTerms('"Church growth" -scandal OR a lagos'),['church','growth','lagos']);
  const segments=highlightSegments('Churches in Lagos <b>grow</b>; preachurch',queryTerms('church grow'));
  assert.deepEqual(segments.filter(s=>s.match).map(s=>s.text),['Church','grow']);
  assert.equal(segments.map(s=>s.text).join(''),'Churches in Lagos <b>grow</b>; preachurch','text is preserved exactly, never parsed');
  assert.deepEqual(highlightSegments('Ẹ̀kọ́ ọ̀rọ̀ Ọlọ́run',queryTerms('ọ̀rọ̀')).filter(s=>s.match).map(s=>s.text),['ọ̀rọ̀']);
  assert.deepEqual(highlightSegments('a.b (c)',queryTerms('a.b (c')),[{text:'a.b',match:true},{text:' (c)',match:false}]);
  assert.deepEqual(highlightSegments('',['x']),[]);
});

test('topic/author payloads are validated leniently in shape and strictly in content',()=>{
  const card={id:1,slug:'a-story',title:'A <story>',excerpt:'x',publishedAt:'2026-10-01T00:00:00Z',category:{title:'News'}};
  const topic=normalizeTopicPayload({topic:{name:'Youth',slug:'youth',kind:'ministry',description:'d'.repeat(500),isPublic:true},articles:[card,card,{...card,slug:'Bad slug'},{...card,slug:'draft',status:'draft'}]},{baseUrl:origin});
  assert.equal(topic.kind,'ministry');assert.equal(topic.description.length,400);assert.deepEqual(topic.articles.map(a=>a.slug),['a-story']);
  assert.equal(normalizeTopicPayload({name:'Flat',slug:'flat',kind:'weird',docs:[card]}).kind,'topic');
  assert.equal(normalizeTopicPayload({name:'Flat',slug:'flat',docs:[card]}).articles.length,1);
  assert.equal(normalizeTopicPayload({topic:{name:'Hidden',slug:'hidden',isPublic:false}}),null);
  assert.equal(normalizeTopicPayload({topic:{name:'',slug:'x'}}),null);
  assert.equal(normalizeAuthorPayload({author:{name:'Ada',slug:'ada',role:'Editor'},articles:[card]}).articles[0].title,'A <story>');
});

test('fetchTaxonomy: anonymous GET, 404 => null, 429 keeps Retry-After, bad slugs make no request',async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,options});const u=new URL(url);
    if(u.pathname.endsWith('/missing'))return new Response('{}',{status:404});
    if(u.pathname.endsWith('/busy'))return new Response('{}',{status:429,headers:{'Retry-After':'12'}});
    return Response.json({topic:{name:'Faith',slug:'faith'},articles:[]});};
  assert.equal((await fetchTaxonomy({kind:'topic',slug:'faith',baseUrl:origin,fetchImpl})).name,'Faith');
  assert.equal(calls[0].url,origin+'/api/public/topics/faith');assert.equal(calls[0].options.credentials,'omit');
  assert.equal(await fetchTaxonomy({kind:'topic',slug:'missing',baseUrl:origin,fetchImpl}),null);
  await assert.rejects(fetchTaxonomy({kind:'author',slug:'busy',baseUrl:origin,fetchImpl}),e=>e.status===429&&e.retryAfter===12);
  assert.equal(await fetchTaxonomy({kind:'topic',slug:'../admin',baseUrl:origin,fetchImpl}),null);
  assert.equal(calls.length,3);
  await assert.rejects(fetchTaxonomy({kind:'topic',slug:'x',baseUrl:'javascript:alert(1)',fetchImpl}),e=>e.type==='configuration');
  assert.deepEqual((await fetchTopicIndex({baseUrl:origin,fetchImpl:async()=>Response.json({docs:[{name:'A',slug:'a'},{name:'B',slug:'b',isPublic:false}]})})).map(t=>t.slug),['a']);
});

test('Following feed merges, de-duplicates and sorts newest first; failures are counted, not thrown',async()=>{
  const a=(slug,day)=>({slug,title:slug,publishedAt:`2026-10-${day}T00:00:00.000Z`});
  const merged=mergeFollowedArticles([{follow:{kind:'topic',slug:'t',name:'T'},articles:[a('one','01'),a('two','03')]},{follow:{kind:'author',slug:'w',name:'W'},articles:[a('two','03'),a('three','02')]}]);
  assert.deepEqual(merged.map(e=>e.article.slug),['two','three','one']);assert.equal(merged[0].via.length,2);
  assert.equal(mergeFollowedArticles([{follow:{kind:'topic',slug:'t'},articles:Array.from({length:30},(_,i)=>a('s'+i,'01'))}]).length,12);
  const follows=[{kind:'topic',slug:'ok',name:'OK'},{kind:'topic',slug:'down',name:'Down'},{kind:'author',slug:'gone',name:'Gone'}];
  const result=await loadFollowingFeed({baseUrl:origin,follows,fetchImpl:async url=>url.endsWith('/down')?new Response('x',{status:500}):url.endsWith('/gone')?new Response('',{status:404}):Response.json({topic:{name:'OK',slug:'ok'},articles:[a('fresh','05')]})});
  assert.equal(result.failures,1);assert.equal(result.total,3);assert.deepEqual(result.missing.map(f=>f.slug),['gone']);assert.deepEqual(result.entries.map(e=>e.article.slug),['fresh']);
});

test('search: suggestions only when configured, online, unpaused and >= 3 characters; filters reach the C8 endpoint',async()=>{
  assert.equal(SUGGEST_MIN_CHARS,3);
  assert.equal(shouldSuggest('ab'),false);assert.equal(shouldSuggest('abc'),true);assert.equal(shouldSuggest('abc',{online:false}),false);
  assert.equal(shouldSuggest('abc',{pausedUntil:2000,now:1000}),false);assert.equal(shouldSuggest('abc',{configured:false}),false);
  const urls=[];const fetchImpl=async url=>{urls.push(new URL(url));return Response.json({docs:[],totalDocs:0});};
  await searchArticles({baseUrl:origin,query:'faith',limit:5,category:'news',year:'2025',fetchImpl});
  await searchArticles({baseUrl:origin,query:'faith',category:'../x',year:'99',fetchImpl});
  assert.equal(urls[0].searchParams.get('category'),'news');assert.equal(urls[0].searchParams.get('year'),'2025');assert.equal(urls[0].searchParams.get('limit'),'5');
  assert.equal(urls[1].searchParams.has('category'),false);assert.equal(urls[1].searchParams.has('year'),false);
  const years=yearOptions(new Date('2026-06-01T00:00:00Z'));assert.equal(years[0],2026);assert.equal(years.at(-1),FIRST_ARCHIVE_YEAR);
});

test('topic routes and JSON-LD',()=>{
  assert.deepEqual(topicRoute('/topic/'),['index']);assert.deepEqual(topicRoute('/topic'),['index']);
  assert.deepEqual(topicRoute('/topic/youth-ministry/'),['topic','youth-ministry']);assert.deepEqual(topicRoute('/topic/Bad%20slug/'),['invalid']);
  assert.deepEqual(topicRoute('/topic/a/b/'),['invalid']);assert.equal(topicRoute('/topics/'),null);assert.equal(topicRoute('/news/topic/a/'),null);
  assert.deepEqual(topicRoute('/sub/topic/a/','/sub/'),['topic','a']);
  const [page,crumbs]=topicSchema({name:'Youth',description:'d'},'https://public.example.test/topic/youth/',{siteUrl:'https://public.example.test',basePath:'/'});
  assert.equal(page['@type'],'CollectionPage');assert.deepEqual(crumbs.itemListElement.map(i=>i.name),['Home','Topics','Youth']);
});

async function hostFixture(t,{indexable=true,mode='ok'}={}) {
  const dist=await mkdtemp(join(tmpdir(),'growth-topic-test-'));
  await writeFile(join(dist,'index.html'),await readFile(new URL('../src/index.template.html',import.meta.url),'utf8'));
  const calls=[];
  const server=createPublicServer({articlePathTemplate:'/reports/{slug}/',dist,cmsUrl:origin,siteUrl:'https://public.example.test',indexable,fetchImpl:async(url,options)=>{
    const u=new URL(url);calls.push(u);assert.equal(options.credentials,'omit');
    if(mode==='down')return new Response('private failure',{status:500});
    if(u.pathname==='/api/public/topics')return Response.json({docs:[{name:'Youth & <Ministry>',slug:'youth',kind:'ministry'}]});
    if(u.pathname==='/api/public/topics/youth')return Response.json({topic:{name:'Youth & <Ministry>',slug:'youth',kind:'ministry',description:'Young <people> "today"'},articles:[{id:1,slug:'faith-story',title:'Faith <story> & life',excerpt:'Excerpt <script>alert(1)</script>',publishedAt:'2026-10-20T08:00:00Z',category:{title:'News'}}]});
    if(u.pathname==='/api/public/topics/hidden')return Response.json({topic:{name:'Hidden',slug:'hidden',isPublic:false}});
    return new Response('{}',{status:404});
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dist,{recursive:true,force:true});});
  return {get:(path,options)=>fetch('http://127.0.0.1:'+server.address().port+'/'+path,{redirect:'manual',...options}),calls};
}

test('public host renders /topic/{slug}/ server-side: escaped, canonical, JSON-LD, embedded JSON, cached',async t=>{
  const {get,calls}=await hostFixture(t);
  const response=await get('topic/youth/');
  assert.equal(response.status,200);assert.equal(response.headers.get('x-robots-tag'),'index,follow');
  const html=await response.text();
  assert.match(html,/<title>Youth &amp; &lt;Ministry&gt; — Church Times Nigeria<\/title>/);
  assert.match(html,/<link rel="canonical" href="https:\/\/public.example.test\/topic\/youth\/">/);
  assert.match(html,/"@type":"CollectionPage"/);assert.match(html,/"@type":"BreadcrumbList"/);
  assert.match(html,/<script id="public-topic" type="application\/json">/);
  assert.match(html,/href="\/reports\/faith-story\/">Faith &lt;story&gt; &amp; life<\/a>/);
  assert.doesNotMatch(html.replace(/<script id="public-topic"[\s\S]*?<\/script>/,'').replace(/<script type="application\/ld\+json"[\s\S]*?<\/script>/,''),/<script>alert|<Ministry>|<people>/);
  assert.doesNotMatch(html,/<\/script><script>alert/);
  assert.match(html,/>Ministry</);
  const count=calls.length;await get('topic/youth/');assert.equal(calls.length,count,'lookup cache reused');
  const redirect=await get('topic/youth');assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'/topic/youth/');
  const index=await get('topic/');assert.equal(index.status,200);assert.match(await index.text(),/href="\/topic\/youth\/">Youth &amp; &lt;Ministry&gt;<\/a>/);
});

test('public host topic pages: 404 for unknown, hidden or invalid slugs; 503 (uncached) when the CMS fails',async t=>{
  const {get}=await hostFixture(t,{indexable:true});
  for(const path of ['topic/unknown/','topic/hidden/','topic/Bad%20Slug/','topic/a/b/']) {
    const response=await get(path);assert.equal(response.status,404,path);assert.equal(response.headers.get('x-robots-tag'),'noindex,nofollow');
    assert.doesNotMatch(await response.text(),/rel="canonical"/);
  }
  const down=await hostFixture(t,{mode:'down'});
  const failed=await down.get('topic/youth/');assert.equal(failed.status,503);assert.equal(failed.headers.get('retry-after'),'60');
  await down.get('topic/youth/');assert.equal(down.calls.length,2,'failures are not cached');
});
