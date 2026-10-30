import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicServer} from '../tools/serve-public.mjs';
import {calendarYear,seasonRanges,createChurchCalendarRoute} from '../tools/public-routes/church-calendar.mjs';

const INDEX='<!doctype html><html><head><title>Church Times Nigeria</title><meta name="description" content="Home"><meta property="og:title" content="x"><meta property="og:description" content="y"><script type="module" crossorigin src="./site/assets/index-abc.js"></script><link rel="stylesheet" crossorigin href="./site/assets/index-abc.css"></head><body><a class="skip-link" href="#main">Skip to content</a><div id="app"></div></body></html>';

async function withServer(options,run){
  const root=await mkdtemp(join(tmpdir(),'church-calendar-'));const dist=join(root,'dist');
  await mkdir(dist,{recursive:true});await writeFile(join(dist,'index.html'),INDEX);
  const server=createPublicServer({dist,...options});await server.publicReady;await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{await run('http://127.0.0.1:'+server.address().port);}
  finally{await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
}

test('calendarYear: default is the Lagos year; only one four-digit year in range is accepted',()=>{
  const now=new Date('2026-12-31T23:30:00Z');
  assert.equal(calendarYear(new URLSearchParams(''),now),2027);
  assert.equal(calendarYear(new URLSearchParams('year=2030')),2030);
  for(const bad of ['year=1899','year=2200','year=20x6','year=','year=2026&year=2027','year=%3Cscript%3E','year=02026'])assert.equal(calendarYear(new URLSearchParams(bad)),null,bad);
});

test('season ranges tile the whole civil year without gaps or overlaps',()=>{
  for(const year of [1900,2024,2026,2038,2100,2199]) {
    const ranges=seasonRanges(year);
    assert.equal(ranges[0].from,`${year}-01-01`);assert.equal(ranges.at(-1).to,`${year}-12-31`);
    for(let i=1;i<ranges.length;i++) {
      const next=new Date(Date.parse(`${ranges[i-1].to}T00:00:00Z`)+86400000).toISOString().slice(0,10);
      assert.equal(ranges[i].from,next,`${year} ${ranges[i].key}`);
    }
  }
});

for(const basePath of ['/','/journal/'])test(`serves a complete, script-free calendar page at ${basePath}church-calendar/`,async()=>{
  await withServer({basePath,siteUrl:'https://churchtimes.example',indexable:true},async origin=>{
    const page=await fetch(origin+basePath+'church-calendar/?year=2026');
    assert.equal(page.status,200);
    assert.equal(page.headers.get('content-type'),'text/html; charset=utf-8');
    const html=await page.text();
    assert.match(html,/<title>Church calendar 2026 — Church Times Nigeria<\/title>/);
    assert.match(html,/<time datetime="2026-04-05">Sunday 5 April<\/time><\/td><td>Easter Day/);
    assert.match(html,/Orthodox Easter \(Pascha\)/);
    assert.match(html,/<time datetime="2026-11-29">Sunday 29 November<\/time><\/td><td>Advent Sunday/);
    assert.match(html,/<main id="main" tabindex="-1" class="container section-list ct-cal">/);
    assert.doesNotMatch(html,/type="module"/,'the SPA script is left out so it cannot replace the page');
    assert.match(html,/href="\.\/site\/scripture\/calendar\.css"/);
    assert.match(html,new RegExp(`<base href="${basePath}">`));
    assert.match(html,/<meta name="robots" content="noindex,follow">/,'year views are not indexed');
    assert.doesNotMatch(html,/rel="canonical"/);

    const current=await fetch(origin+basePath+'church-calendar/');
    const currentHTML=await current.text();
    assert.equal(current.status,200);
    assert.equal(current.headers.get('cache-control'),'public, max-age=600');
    assert.match(currentHTML,/<meta name="robots" content="index,follow">/);
    assert.match(currentHTML,new RegExp(`<link rel="canonical" href="https://churchtimes.example${basePath}church-calendar/">`));
    assert.match(currentHTML,/Today in Lagos/);

    const head=await fetch(origin+basePath+'church-calendar/',{method:'HEAD'});
    assert.equal(head.status,200);assert.equal(await head.text(),'');

    const redirect=await fetch(origin+basePath+'church-calendar?year=2027',{redirect:'manual'});
    assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),basePath+'church-calendar/?year=2027');

    const bad=await fetch(origin+basePath+'church-calendar/?year=%3Cscript%3Ealert(1)%3C/script%3E');
    assert.equal(bad.status,400);
    const badHTML=await bad.text();
    assert.doesNotMatch(badHTML,/<script>alert/);
    assert.match(badHTML,/Choose a year from 1900 to 2199/);
    assert.equal(bad.headers.get('cache-control'),'no-store');

    assert.notEqual((await fetch(origin+basePath+'church-calendar/extra')).status,200);
  });
});

test('not indexable without an HTTPS site URL; previous/next links stop at the range ends',async()=>{
  const route=createChurchCalendarRoute({dist:'unused',basePath:'/',indexable:true});
  assert.equal(await route(new URL('http://x/other/'),()=>assert.fail('must not respond')),false);
  await withServer({basePath:'/'},async origin=>{
    const html=await (await fetch(origin+'/church-calendar/')).text();
    assert.match(html,/content="noindex,follow"/);
    const first=await (await fetch(origin+'/church-calendar/?year=1900')).text();
    assert.doesNotMatch(first,/year=1899/);assert.match(first,/year=1901/);
    const last=await (await fetch(origin+'/church-calendar/?year=2199')).text();
    assert.doesNotMatch(last,/year=2200/);assert.match(last,/year=2198/);
  });
});
