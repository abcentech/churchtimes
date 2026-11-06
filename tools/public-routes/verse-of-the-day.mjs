// GET {base}scripture/verse-of-the-day.json[?date=YYYY-MM-DD]: the same deterministic verse the site shows
// (src/features/growth/scripture/daily.js), with its bundled public-domain KJV text, as JSON. Read by the CMS
// newsletter digest when `includeDevotional` is on, so the inbox and the site agree. No CMS, no external API:
// the text is read from the built site's own scripture files.
import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {dailyVerseFor} from '../../src/features/growth/scripture/daily.js';
import {formatReference} from '../../src/features/growth/scripture/refs.js';
import {versesFor} from '../../src/features/growth/scripture/text.js';
import {lagosDate} from '../../src/features/growth/liturgical.js';

const DATE=/^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar date between 1900 and 2199, or null. */
export function verseDate(searchParams,now=new Date()){
  const values=searchParams.getAll('date');
  if(!values.length)return lagosDate(now);
  if(values.length!==1 || !DATE.test(values[0]))return null;
  const year=Number(values[0].slice(0,4));
  const parsed=new Date(`${values[0]}T00:00:00Z`);
  return year>=1900 && year<=2199 && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10)===values[0] ? values[0] : null;
}

async function scriptureDir(dist){
  for(const dir of [resolve(dist,'site','scripture','kjv'),resolve(dist,'scripture','kjv')]) {
    if((await stat(dir).catch(()=>null))?.isDirectory())return dir;
  }
  return null;
}

/** File-backed fetch for text.js (same JSON files the browser loads). */
const fileFetch=async href=>{
  try {const body=await readFile(new URL(href),'utf8');return {ok:true,status:200,json:async()=>JSON.parse(body)};}
  catch {return {ok:false,status:404,json:async()=>null};}
};

/** { date, reference, text, version, season } for a Lagos date. */
export async function verseOfTheDay(date,{dist}){
  const dir=await scriptureDir(dist);
  if(!dir)throw new Error('Scripture text is not built');
  const pick=dailyVerseFor(date);
  const {verses,truncated}=await versesFor(pick.reference,{limit:6,baseUrl:pathToFileURL(dir+'/').href,fetchImpl:fileFetch});
  const text=verses.map(v=>v.text).join(' ')+(truncated?' …':'');
  return {date:pick.date,reference:formatReference(pick.reference),text,version:'KJV',versionLabel:'King James Version (public domain)',season:pick.season.feast?.name||pick.season.name};
}

export function createVerseOfTheDayRoute({dist,basePath='/',now=()=>new Date()}){
  const path=`${basePath}scripture/verse-of-the-day.json`;
  return async function verseRoute(url,respond){
    if(url.pathname!==path)return false;
    const json=(status,body,extra={})=>respond(status,'application/json; charset=utf-8',JSON.stringify(body),{'X-Robots-Tag':'noindex','Access-Control-Allow-Origin':'*',...extra});
    const date=verseDate(url.searchParams,now());
    if(!date){json(400,{ok:false,error:'date must be YYYY-MM-DD between 1900 and 2199'},{'Cache-Control':'no-store'});return true;}
    try {json(200,{ok:true,...await verseOfTheDay(date,{dist})},{'Cache-Control':'public, max-age=3600'});}
    catch {json(503,{ok:false,error:'Verse of the day is unavailable'},{'Cache-Control':'no-store','Retry-After':'300'});}
    return true;
  };
}
