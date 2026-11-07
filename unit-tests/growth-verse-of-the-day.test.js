import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPublicServer} from '../tools/serve-public.mjs';
import {verseDate,verseOfTheDay} from '../tools/public-routes/verse-of-the-day.mjs';
import {dailyVerseFor} from '../src/features/growth/scripture/daily.js';

const KJV=fileURLToPath(new URL('../public/scripture/kjv/',import.meta.url));

async function withDist(layout,run){
  const root=await mkdtemp(join(tmpdir(),'verse-day-'));const dist=join(root,'dist');
  await mkdir(dist,{recursive:true});await writeFile(join(dist,'index.html'),'<!doctype html><html><head><title>x</title></head><body><div id="app"></div></body></html>');
  if(layout)await cp(KJV,join(dist,...layout,'scripture','kjv'),{recursive:true});
  try{await run(dist);}finally{await rm(root,{recursive:true,force:true});}
}

test('verseDate: Lagos today by default; only one real YYYY-MM-DD in 1900-2199',()=>{
  assert.equal(verseDate(new URLSearchParams(''),new Date('2026-10-30T23:30:00Z')),'2026-10-31');
  assert.equal(verseDate(new URLSearchParams('date=2026-12-25')),'2026-12-25');
  for(const bad of ['date=2026-02-30','date=1899-12-31','date=2200-01-01','date=2026-1-1','date=x','date=2026-10-30&date=2026-10-31'])assert.equal(verseDate(new URLSearchParams(bad)),null,bad);
});

test('verse of the day matches the site pick and carries KJV text only',async()=>{
  await withDist([],async dist=>{
    const christmas=await verseOfTheDay('2026-12-25',{dist});
    assert.equal(christmas.reference,'Luke 2:10–11');
    assert.match(christmas.text,/^And the angel said unto them, Fear not/);
    assert.equal(christmas.version,'KJV');
    assert.equal(christmas.versionLabel,'King James Version (public domain)');
    const day=await verseOfTheDay('2026-10-30',{dist});
    assert.equal(day.date,dailyVerseFor('2026-10-30').date);
    assert.ok(day.text.length>10&&day.text.length<2000);
  });
});

for(const [label,layout] of [['root',[]],['prepared site/',['site']]])test(`serves JSON from the ${label} dist layout, and a clean 503 when the text is missing`,async()=>{
  await withDist(layout,async dist=>{
    const server=createPublicServer({dist});await server.publicReady;await new Promise(r=>server.listen(0,'127.0.0.1',r));
    try {
      const origin='http://127.0.0.1:'+server.address().port;
      const ok=await fetch(origin+'/scripture/verse-of-the-day.json?date=2026-04-05');
      assert.equal(ok.status,200);
      assert.match(ok.headers.get('content-type'),/application\/json/);
      assert.equal(ok.headers.get('cache-control'),'public, max-age=3600');
      const body=await ok.json();
      assert.equal(body.ok,true);assert.equal(body.reference,'Matthew 28:6');assert.equal(body.version,'KJV');
      const bad=await fetch(origin+'/scripture/verse-of-the-day.json?date=2026-13-01');
      assert.equal(bad.status,400);
    } finally {await new Promise(r=>server.close(r));}
  });
});

test('503 when the scripture text was not built',async()=>{
  await withDist(null,async dist=>{
    const server=createPublicServer({dist});await server.publicReady;await new Promise(r=>server.listen(0,'127.0.0.1',r));
    try {
      const res=await fetch('http://127.0.0.1:'+server.address().port+'/scripture/verse-of-the-day.json');
      assert.equal(res.status,503);assert.equal(res.headers.get('retry-after'),'300');
    } finally {await new Promise(r=>server.close(r));}
  });
});
