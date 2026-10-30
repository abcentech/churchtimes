// Lazy, same-origin loader for the bundled public-domain KJV text (public/scripture/kjv/<book>.json, an array of
// chapters, each an array of verse strings). No external API: the files ship with the site.
import {BOOK_INDEX} from './books.js';
import {referenceVerses} from './refs.js';

export const VERSION_LABEL='King James Version (public domain)';
const env=import.meta.env||{};
const cache=new Map();

/** Directory URL of the bundled text, following the asset convention in src/main.js (built assets live under site/). */
export function defaultScriptureBase(){
  const doc=typeof document!=='undefined'?document:null;
  return new URL(`${env.BASE_URL??'./'}${env.PROD?'site/':''}scripture/kjv/`,doc?.baseURI||globalThis.location?.href||'file:///').href;
}

const validBook=data=>Array.isArray(data) && data.length>0 && data.every(ch=>Array.isArray(ch) && ch.length>0 && ch.every(v=>typeof v==='string'));

/** Resolves to the book's chapters; rejects on network or format errors (and then forgets the failure). */
export function loadBook(id,{baseUrl=defaultScriptureBase(),fetchImpl=globalThis.fetch}={}){
  if(!BOOK_INDEX.has(id))return Promise.reject(new Error('Unknown book'));
  const key=baseUrl+id;
  if(!cache.has(key)) {
    const job=(async()=>{
      const response=await fetchImpl(new URL(`${id}.json`,baseUrl).href,{credentials:'omit'});
      if(!response.ok)throw new Error(`Scripture text unavailable (${response.status})`);
      const data=await response.json();
      if(!validBook(data))throw new Error('Unexpected scripture data');
      return data;
    })();
    cache.set(key,job);
    job.catch(()=>cache.delete(key));
  }
  return cache.get(key);
}

/** { verses: [{chapter, verse, text}], truncated } for a parsed reference, at most `limit` verses. */
export async function versesFor(ref,{limit=6,...options}={}){
  const book=await loadBook(ref.book,options);
  const {verses,truncated}=referenceVerses(ref,limit);
  const out=verses.map(([chapter,verse])=>({chapter,verse,text:book[chapter-1]?.[verse-1]}));
  if(out.some(v=>typeof v.text!=='string'))throw new Error('Verse not found');
  return {verses:out,truncated};
}

/** Test helper. */
export const clearScriptureCache=()=>cache.clear();
