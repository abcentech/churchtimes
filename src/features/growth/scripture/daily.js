// Verse of the day: a deterministic pick by the Lagos civil date from curated, season-aware reference lists.
// The text comes only from the bundled public-domain KJV (text.js); nothing is generated or fetched elsewhere.
import {lagosDate,seasonFor,colourName} from '../liturgical.js';
import {parseReference,formatReference} from './refs.js';
import {versesFor,VERSION_LABEL} from './text.js';

export const DAILY_VERSES={
  advent:['Isaiah 9:6','Isaiah 40:3','Isaiah 7:14','Micah 5:2','Malachi 3:1','Luke 1:46-47','Romans 13:12','Psalm 25:4-5','Luke 1:78-79','Isaiah 2:4','Jeremiah 33:14','Mark 13:33','1 Thessalonians 5:23','Isaiah 35:4'],
  christmas:['Luke 2:10-11','Luke 2:14','John 1:14','Matthew 1:23','Isaiah 9:2','Galatians 4:4-5','Titus 2:11','John 1:5'],
  epiphany:['Matthew 2:10-11','Isaiah 60:1','Matthew 3:17','Isaiah 60:3','John 1:9','Ephesians 3:6'],
  lent:['Joel 2:13','Psalm 51:10','Matthew 4:4','Isaiah 58:6','Psalm 51:17','Luke 9:23','2 Corinthians 5:17','Micah 6:8','Matthew 6:6','James 4:8','Isaiah 55:6-7','Romans 5:8'],
  'holy-week':['Matthew 21:9','John 13:34','Isaiah 53:5','John 15:13','Luke 23:34','Philippians 2:8','Mark 14:36','John 19:30'],
  easter:['Matthew 28:6','John 11:25','1 Corinthians 15:20','1 Peter 1:3','Romans 6:4','1 Corinthians 15:55','Revelation 1:18','Luke 24:34','John 20:29','Colossians 3:1','John 14:26','Acts 1:8'],
  ordinary:['John 3:16','Psalm 23:4','Proverbs 3:5-6','Jeremiah 29:11','Romans 8:28','Philippians 4:13','Isaiah 40:31','Joshua 1:9','Psalm 46:10','Matthew 11:28','Romans 12:2','Galatians 5:22-23','Hebrews 11:1','Philippians 4:6-7','2 Timothy 1:7','Psalm 121:7-8','Lamentations 3:22-23','Matthew 6:33','1 John 1:9','Psalm 27:14','Isaiah 41:10','Romans 15:13','Colossians 3:23','Psalm 119:105','Proverbs 16:3','Matthew 5:16','Hebrews 13:8','James 1:5','1 Peter 5:7','Psalm 37:4','Romans 12:12','Ephesians 2:8-9','2 Corinthians 12:9','Psalm 34:8','Psalm 91:1-2','Deuteronomy 31:6','Nehemiah 8:10','Psalm 100:4-5','Matthew 22:37-39','John 14:6','John 14:27','Romans 10:9','1 Corinthians 13:13','Ephesians 4:32','Philippians 4:8','Colossians 3:15','1 Thessalonians 5:16-18','Hebrews 12:1-2','James 1:22','1 John 4:19','Revelation 3:20','Psalm 118:24','Proverbs 22:6','Isaiah 26:3','Zephaniah 3:17','Psalm 103:2','Galatians 6:9','Matthew 5:9','Amos 5:24','Psalm 19:14','John 8:32'],
};
// Principal feasts read their own verse.
export const FEAST_VERSES={easter:'Matthew 28:6',christmas:'Luke 2:10-11',pentecost:'Acts 2:4','good-friday':'John 19:30','palm-sunday':'Matthew 21:9','ash-wednesday':'Joel 2:13',epiphany:'Matthew 2:10-11',ascension:'Acts 1:11',trinity:'Matthew 28:19','maundy-thursday':'John 13:34'};

const dayNumber=iso=>Math.floor(Date.parse(`${iso}T00:00:00Z`)/86400000);

/** { date, season, reference } for a Lagos date (default today). Same date, same verse, for every reader. */
export function dailyVerseFor(date=lagosDate()){
  const season=seasonFor(date);
  const list=DAILY_VERSES[season.key]||DAILY_VERSES.ordinary;
  const text=FEAST_VERSES[season.feast?.key]||list[((dayNumber(date)%list.length)+list.length)%list.length];
  return {date:season.date,season,reference:parseReference(text)};
}

const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};

/**
 * Renders the verse of the day into `element` (DOM text nodes only). Hides the element if the text cannot be
 * loaded, so no empty box is left behind. Returns a dispose function.
 */
export function mountDailyVerse(element,{date,...options}={}){
  if(!element)return ()=>{};
  let disposed=false;
  const {season,reference}=dailyVerseFor(date||lagosDate());
  element.setAttribute('aria-busy','true');
  versesFor(reference,{limit:6,...options}).then(({verses,truncated})=>{
    if(disposed || !element.isConnected)return;
    const figure=el('figure','ct-daily-verse');
    const caption=el('figcaption','ct-daily-verse-head');
    caption.append(el('span','ct-daily-verse-eyebrow','Verse of the day'),el('span','ct-daily-verse-season',season.feast?season.feast.name:`${season.name} · ${colourName(season.colour)}`));
    const quote=el('blockquote','ct-daily-verse-text');
    quote.append(el('p','',verses.map(v=>v.text).join(' ')+(truncated?' …':'')));
    const source=el('p','ct-daily-verse-ref');
    const abbr=el('abbr','','KJV');abbr.title='King James Version';
    source.append(el('cite','',formatReference(reference)),' ',abbr);
    figure.append(caption,quote,source,el('p','ct-daily-verse-label',VERSION_LABEL));
    element.replaceChildren(figure);
    element.hidden=false;
  }).catch(()=>{if(!disposed){element.replaceChildren();element.hidden=true;}}).finally(()=>{if(!disposed)element.removeAttribute('aria-busy');});
  return ()=>{disposed=true;};
}
