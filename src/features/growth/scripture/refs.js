// Scripture reference parser (pure, no DOM). Finds references such as "John 3:16", "Jn 3:16-18", "1 Cor. 13:4–7",
// "Psalm 23", "Ps 23:1", "Romans 8:28, 31" and "John 3:16–4:2" in plain text, validated against KJV versification.
// Book names must be capitalised as in running prose. Abbreviations always need a verse ("Ps 23:1"); a bare chapter
// ("Psalm 23") is accepted only for a full book name that is not also a common personal name or English word.
import {BOOKS} from './books.js';
import {VERSE_COUNTS} from './canon.js';

const PREFIXES={1:['1','1st','I','First'],2:['2','2nd','II','Second'],3:['3','3rd','III','Third']};
// Full names that also read as names or words in ordinary prose: these need "chapter:verse".
const NEEDS_VERSE=new Set(['numbers','job','mark','acts','james','jude','titus','daniel','joel','amos','ruth','esther','ezra','john','jonah','micah','nahum','luke','timothy','peter','samuel','kings','chronicles','the revelation','revelations','song of songs','canticles']);
const escapeRe=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const forms=[];
for(const book of BOOKS) {
  const bases=[...book.names.map(name=>({name,full:true})),...book.abbr.map(name=>({name,full:false}))];
  for(const {name,full} of bases) {
    const chapterOnly=full && !NEEDS_VERSE.has(name.toLowerCase()) && !book.num;
    if(!book.num)forms.push({text:name,pattern:escapeRe(name).replace(/ /g,'\\s+'),book,chapterOnly,abbr:!full});
    else for(const prefix of PREFIXES[book.num]) {
      const gap=/^\d/.test(prefix) && !/[a-z]$/.test(prefix)?'\\s*':'\\s+';
      forms.push({text:`${prefix} ${name}`,pattern:escapeRe(prefix)+gap+escapeRe(name).replace(/ /g,'\\s+'),book,chapterOnly,abbr:!full});
    }
  }
}
forms.sort((a,b)=>b.text.length-a.text.length);
const DASH='[-–—]';
const SOURCE=`(?<![\\p{L}\\p{N}])(${forms.map(f=>f.pattern).join('|')})(\\.?)\\s+(\\d{1,3})(?::(\\d{1,3})(?:\\s*${DASH}\\s*(\\d{1,3})(?::(\\d{1,3}))?)?((?:\\s*,\\s*\\d{1,3}(?:\\s*${DASH}\\s*\\d{1,3})?)*))?(?![\\p{L}\\p{N}:])`;
const MAX_INPUT=100000;

function formFor(matched){
  const norm=matched.replace(/\s+/g,' ');
  return forms.find(f=>new RegExp(`^(?:${f.pattern})$`,'u').test(norm));
}
const verseCount=(bookIndex,chapter)=>VERSE_COUNTS[bookIndex]?.[chapter-1]||0;

/**
 * Every valid reference in `text`, in order: { index, length, text, book, chapter, verse, endChapter, endVerse,
 * extra: [[from,to],...] }. `verse` is null for a whole chapter. Invalid or out-of-range references are skipped.
 */
export function findReferences(text){
  if(typeof text!=='string' || !text || text.length>MAX_INPUT)return [];
  const out=[];
  const re=new RegExp(SOURCE,'gu');
  for(const match of text.matchAll(re)) {
    const form=formFor(match[1]);
    if(!form)continue;
    const ref=buildReference(form,match);
    if(ref)out.push({index:match.index,length:match[0].length,text:match[0],...ref});
  }
  return out;
}

function buildReference(form,match){
  const book=form.book,bookIndex=BOOKS.indexOf(book),chapters=VERSE_COUNTS[bookIndex].length;
  if(form.abbr && match[2]==='.' && !match[4] && chapters>1)return null;
  let chapter=Number(match[3]),verse=match[4]?Number(match[4]):null,endChapter=chapter,endVerse=verse;
  if(verse===null) {
    // "Jude 3" / "Philemon 4": single-chapter books cite verses directly.
    if(chapters===1){verse=chapter;chapter=1;endChapter=1;endVerse=verse;}
    else if(!form.chapterOnly)return null;
  } else if(match[5]) {
    if(match[6]){endChapter=Number(match[5]);endVerse=Number(match[6]);}
    else endVerse=Number(match[5]);
  }
  if(chapter<1 || chapter>chapters || endChapter<chapter || endChapter>chapters)return null;
  if(verse!==null) {
    if(verse<1 || verse>verseCount(bookIndex,chapter) || endVerse<1 || endVerse>verseCount(bookIndex,endChapter))return null;
    if(endChapter===chapter && endVerse<verse)return null;
  }
  const extra=[];
  if(match[7]) {
    if(endChapter!==chapter)return null;
    for(const part of match[7].split(',').map(s=>s.trim()).filter(Boolean)) {
      const [from,to=from]=part.split(new RegExp(`\\s*${DASH}\\s*`)).map(Number);
      if(from<1 || to<from || to>verseCount(bookIndex,chapter))return null;
      extra.push([from,to]);
    }
  }
  return {book:book.id,bookName:book.name,chapter,verse,endChapter,endVerse,extra};
}

/** Canonical display form, e.g. "1 Corinthians 13:4–7", "Psalms 23", "John 3:16–4:2", "Romans 8:28, 31". */
export function formatReference(ref){
  const name=ref.book==='ps' && ref.verse!==null ? 'Psalm' : ref.bookName;
  if(ref.verse===null)return `${name} ${ref.chapter}`.replace(/^Psalms /,'Psalm ');
  const single=VERSE_COUNTS[BOOKS.findIndex(b=>b.id===ref.book)].length===1;
  let out=single?`${name} ${ref.verse}`:`${name} ${ref.chapter}:${ref.verse}`;
  if(ref.endChapter!==ref.chapter)out+=`–${ref.endChapter}:${ref.endVerse}`;
  else if(ref.endVerse!==ref.verse)out+=`–${ref.endVerse}`;
  for(const [from,to] of ref.extra)out+=`, ${from===to?from:`${from}–${to}`}`;
  return out;
}

/** [chapter, verse] pairs the reference covers, at most `limit`; `truncated` says whether more were left out. */
export function referenceVerses(ref,limit=6){
  const bookIndex=BOOKS.findIndex(b=>b.id===ref.book);
  const list=[];
  const push=(c,v)=>{list.push([c,v]);return list.length>limit;};
  let over=false;
  if(ref.verse===null) {
    for(let v=1;v<=verseCount(bookIndex,ref.chapter) && !over;v++)over=push(ref.chapter,v);
  } else {
    for(let c=ref.chapter;c<=ref.endChapter && !over;c++) {
      const first=c===ref.chapter?ref.verse:1,last=c===ref.endChapter?ref.endVerse:verseCount(bookIndex,c);
      for(let v=first;v<=last && !over;v++)over=push(c,v);
    }
    for(const [from,to] of ref.extra)for(let v=from;v<=to && !over;v++)over=push(ref.chapter,v);
  }
  return {verses:list.slice(0,limit),truncated:list.length>limit};
}

/** Parses a single canonical-ish reference string (used by the daily-verse list); null when invalid. */
export function parseReference(text){
  const [ref]=findReferences(text);
  return ref && ref.index===0 && ref.length===text.length ? ref : null;
}
