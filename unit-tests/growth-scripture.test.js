import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {BOOKS} from '../src/features/growth/scripture/books.js';
import {VERSE_COUNTS} from '../src/features/growth/scripture/canon.js';
import {findReferences,formatReference,referenceVerses,parseReference} from '../src/features/growth/scripture/refs.js';
import {loadBook,versesFor,clearScriptureCache,VERSION_LABEL} from '../src/features/growth/scripture/text.js';
import {DAILY_VERSES,FEAST_VERSES,dailyVerseFor} from '../src/features/growth/scripture/daily.js';

const dataDir=new URL('../public/scripture/kjv/',import.meta.url);
const book=async id=>JSON.parse(await readFile(new URL(`${id}.json`,dataDir),'utf8'));
// Serves the bundled files to the loader as if over HTTP, without a server.
const localFetch=async url=>{
  const name=new URL(url).pathname.split('/').pop();
  try {const body=await readFile(new URL(name,dataDir),'utf8');return {ok:true,status:200,json:async()=>JSON.parse(body)};}
  catch {return {ok:false,status:404,json:async()=>null};}
};
const options={baseUrl:'https://example.test/site/scripture/kjv/',fetchImpl:localFetch};
const found=text=>findReferences(text).map(r=>[r.text,formatReference(r)]);

test('parses common reference forms and normalises them',()=>{
  assert.deepEqual(found('See John 3:16, Jn 3:16-18 and 1 Cor. 13:4–7.'),[['John 3:16','John 3:16'],['Jn 3:16-18','John 3:16–18'],['1 Cor. 13:4–7','1 Corinthians 13:4–7']]);
  assert.deepEqual(found('Read Psalm 23 and Ps 23:1 then Romans 8:28, 31.'),[['Psalm 23','Psalm 23'],['Ps 23:1','Psalm 23:1'],['Romans 8:28, 31','Romans 8:28, 31']]);
  assert.deepEqual(found('I John 4:8; First Peter 5:7; 2Tim 3:16; II Kings 2:11; 1st Samuel 3:10'),[['I John 4:8','1 John 4:8'],['First Peter 5:7','1 Peter 5:7'],['2Tim 3:16','2 Timothy 3:16'],['II Kings 2:11','2 Kings 2:11'],['1st Samuel 3:10','1 Samuel 3:10']]);
  assert.deepEqual(found('John 3:16–4:2, Jude 3, Philemon 4, Song of Solomon 2:4, Rev 21:4, (Matt. 5:3-12)'),[['John 3:16–4:2','John 3:16–4:2'],['Jude 3','Jude 3'],['Philemon 4','Philemon 4'],['Song of Solomon 2:4','Song of Solomon 2:4'],['Rev 21:4','Revelation 21:4'],['Matt. 5:3-12','Matthew 5:3–12']]);
  assert.deepEqual(found('Psalms 119:105 and Ps 46:1–3, 10'),[['Psalms 119:105','Psalm 119:105'],['Ps 46:1–3, 10','Psalm 46:1–3, 10']]);
});

test('leaves ambiguous, unknown or out-of-range references as plain text',()=>{
  for(const text of ['Mark 2 times','Job 3 offers','Is 40:31','Ps. 23','John 3:99','Psalm 151','Jude 30','1 Cor 17:1','Johnson 3:16','john 3:16','Genesis 0:1','John 3:18-16','Romans 8:28, 99','3 Samuel 1:1','Acts 2','Revelation 3:20–19:1, 4','Matthew 5:3x']) {
    assert.deepEqual(findReferences(text).filter(r=>!/^Revelation 3:20$/.test(r.text)),[],text);
  }
  assert.deepEqual(findReferences(''),[]);
  assert.deepEqual(findReferences(null),[]);
  assert.deepEqual(findReferences('x'.repeat(100001)),[]);
  assert.equal(found('Acts 2:38').length,1,'needs-verse books still match with a verse');
});

test('reports positions so callers can split text nodes',()=>{
  const [ref]=findReferences('As Paul wrote in Romans 12:2, be transformed.');
  assert.equal(ref.index,17);assert.equal(ref.length,'Romans 12:2'.length);assert.equal(ref.book,'rom');
  assert.equal(parseReference('Romans 12:2').chapter,12);
  assert.equal(parseReference('see Romans 12:2'),null);
});

test('referenceVerses expands ranges and caps long passages',()=>{
  assert.deepEqual(referenceVerses(parseReference('John 3:16-18')),{verses:[[3,16],[3,17],[3,18]],truncated:false});
  assert.deepEqual(referenceVerses(parseReference('Romans 8:28, 31')),{verses:[[8,28],[8,31]],truncated:false});
  assert.deepEqual(referenceVerses(parseReference('John 3:35–4:1')),{verses:[[3,35],[3,36],[4,1]],truncated:false});
  const psalm=referenceVerses(parseReference('Psalm 23'));
  assert.equal(psalm.verses.length,6);assert.equal(psalm.truncated,false,'Psalm 23 has exactly 6 verses');
  assert.equal(referenceVerses(parseReference('Psalm 119')).truncated,true);
  assert.equal(referenceVerses(parseReference('Matthew 5:3-12'),6).verses.length,6);
});

test('bundled KJV data: 66 books, 31,102 verses, versification and spot checks',async()=>{
  const files=(await readdir(dataDir)).filter(f=>f.endsWith('.json')).sort();
  assert.deepEqual(files,BOOKS.map(b=>`${b.id}.json`).sort());
  let total=0,bytes=0;
  for(const [index,meta] of BOOKS.entries()) {
    const data=await book(meta.id);
    bytes+=(await stat(new URL(`${meta.id}.json`,dataDir))).size;
    assert.deepEqual(data.map(ch=>ch.length),VERSE_COUNTS[index],meta.id);
    for(const chapter of data)for(const verse of chapter) {
      assert.equal(typeof verse,'string');assert.ok(verse.length>0);
      assert.doesNotMatch(verse,/[[\]¶<>{}]|\s{2}/,`${meta.id}: markup removed`);
      total++;
    }
  }
  assert.equal(total,31102);
  assert.ok(bytes<4.6*1024*1024,`KJV data stays under 4.6 MB (${bytes})`);
  assert.equal(VERSE_COUNTS.length,66);
  assert.equal(VERSE_COUNTS[BOOKS.findIndex(b=>b.id==='john')][2],36);
  assert.equal(VERSE_COUNTS[BOOKS.findIndex(b=>b.id==='ps')].length,150);
  assert.equal(VERSE_COUNTS[BOOKS.findIndex(b=>b.id==='ps')][118],176);
  assert.equal((await book('john'))[2][15],'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.');
  assert.equal((await book('john'))[10][34],'Jesus wept.');
  assert.equal((await book('gen'))[0][0],'In the beginning God created the heaven and the earth.');
  assert.equal((await book('1cor'))[12][3],'Charity suffereth long, and is kind; charity envieth not; charity vaunteth not itself, is not puffed up,');
  assert.equal((await book('rev'))[21].length,21);
});

test('loader fetches one book lazily, caches it, and reports failures',async()=>{
  clearScriptureCache();
  let calls=0;
  const counting=async url=>{calls++;return localFetch(url);};
  const ref=parseReference('John 3:16-17');
  const first=await versesFor(ref,{baseUrl:options.baseUrl,fetchImpl:counting});
  await versesFor(parseReference('John 1:1'),{baseUrl:options.baseUrl,fetchImpl:counting});
  assert.equal(calls,1);
  assert.equal(first.verses[0].verse,16);assert.match(first.verses[1].text,/^For God sent not his Son/);
  await assert.rejects(loadBook('nope',options));
  clearScriptureCache();
  await assert.rejects(loadBook('john',{baseUrl:options.baseUrl,fetchImpl:async()=>({ok:false,status:503,json:async()=>null})}),/503/);
  await assert.rejects(loadBook('john',{baseUrl:options.baseUrl,fetchImpl:async()=>({ok:true,status:200,json:async()=>({not:'a book'})})}),/Unexpected/);
  assert.equal((await loadBook('john',options)).length,21,'a failed load is not cached');
  assert.equal(VERSION_LABEL,'King James Version (public domain)');
});

test('daily verse: every curated reference is valid KJV text without psalm titles; same date, same verse',async()=>{
  const refs=[...Object.values(DAILY_VERSES).flat(),...Object.values(FEAST_VERSES)];
  for(const text of refs) {
    const ref=parseReference(text);
    assert.ok(ref,text);
    const {verses}=await versesFor(ref,options);
    assert.doesNotMatch(verses[0].text,/^(A Psalm|A Song|To the chief Musician|Maschil|Michtam|Shiggaion|A Prayer)/,text);
  }
  assert.deepEqual(dailyVerseFor('2026-10-30'),dailyVerseFor('2026-10-30'));
  assert.notEqual(formatReference(dailyVerseFor('2026-10-30').reference),formatReference(dailyVerseFor('2026-10-31').reference));
  assert.equal(formatReference(dailyVerseFor('2026-04-05').reference),'Matthew 28:6');
  assert.equal(formatReference(dailyVerseFor('2026-12-25').reference),'Luke 2:10–11');
  assert.ok(DAILY_VERSES.advent.includes(formatReference(dailyVerseFor('2026-12-01').reference).replace('–','-')));
  const seen=new Set();for(let d=0;d<365;d++)seen.add(formatReference(dailyVerseFor(new Date(Date.UTC(2026,0,1)+d*86400000).toISOString().slice(0,10)).reference));
  assert.ok(seen.size>60,'a year of verses has variety');
});

test('no non-public-domain translations are bundled',async()=>{
  const sources=['daily.js','hover.js','text.js','index.js'].map(f=>fileURLToPath(new URL(`../src/features/growth/scripture/${f}`,import.meta.url)));
  for(const file of sources)assert.doesNotMatch(await readFile(file,'utf8'),/\b(NIV|ESV|NLT|NKJV|https?:\/\/)/,file);
});
