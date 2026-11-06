// Server-rendered church calendar: GET {base}church-calendar/[?year=YYYY]. Pure calculation (no CMS, no network).
// The page is complete without JavaScript: the single-page app script is left out so it cannot replace the content.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {liturgicalYear,seasonFor,lagosDate,westernEaster,adventSunday,baptismOfTheLord,colourName,SEASONS} from '../../src/features/growth/liturgical.js';
import {siteCanonical,escapeAttribute as escape,replaceSocialHTML,SITE_NAME} from '../../src/lib/public-metadata.js';

export const CALENDAR_MIN_YEAR=1900,CALENDAR_MAX_YEAR=2199;
const DAY=86400000;
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEEKDAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const parse=iso=>new Date(`${iso}T00:00:00Z`);
const shift=(iso,days)=>new Date(parse(iso).getTime()+days*DAY).toISOString().slice(0,10);
const longDate=iso=>{const d=parse(iso);return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;};
const shortDate=iso=>{const d=parse(iso);return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;};

/** The calendar year asked for, the current Lagos year when absent, or null when the query is invalid. */
export function calendarYear(searchParams,now=new Date()){
  const values=searchParams.getAll('year');
  if(!values.length)return Number(lagosDate(now).slice(0,4));
  if(values.length!==1 || !/^\d{4}$/.test(values[0]))return null;
  const year=Number(values[0]);
  return year>=CALENDAR_MIN_YEAR && year<=CALENDAR_MAX_YEAR ? year : null;
}

/** Season date ranges within one civil year (Christmas spans the turn of the year, so it appears twice). */
export function seasonRanges(year){
  const easter=westernEaster(year),advent=adventSunday(year),baptism=baptismOfTheLord(year);
  return [
    {key:'christmas',from:`${year}-01-01`,to:`${year}-01-05`,note:'continuing from the previous year'},
    {key:'epiphany',from:`${year}-01-06`,to:baptism},
    {key:'ordinary',from:shift(baptism,1),to:shift(easter,-47)},
    {key:'lent',from:shift(easter,-46),to:shift(easter,-8)},
    {key:'holy-week',from:shift(easter,-7),to:shift(easter,-1)},
    {key:'easter',from:easter,to:shift(easter,49)},
    {key:'ordinary',from:shift(easter,50),to:shift(advent,-1)},
    {key:'advent',from:advent,to:`${year}-12-24`},
    {key:'christmas',from:`${year}-12-25`,to:`${year}-12-31`,note:'continuing into the new year'},
  ].map(range=>({...range,name:SEASONS[range.key].name,colour:SEASONS[range.key].colour}));
}

export function calendarBody(year,{now=new Date(),path}){
  const today=lagosDate(now),current=today.startsWith(`${year}-`);
  const season=current?seasonFor(today):null;
  const nav=[year>CALENDAR_MIN_YEAR?`<a href="${escape(`${path}?year=${year-1}`)}" rel="prev">${year-1}</a>`:'',year!==Number(today.slice(0,4))?`<a href="${escape(path)}">This year</a>`:'',year<CALENDAR_MAX_YEAR?`<a href="${escape(`${path}?year=${year+1}`)}" rel="next">${year+1}</a>`:''].filter(Boolean).join('');
  const feasts=liturgicalYear(year).map(f=>`<tr${f.date===today?' aria-current="date"':''}><td><time datetime="${f.date}">${escape(longDate(f.date))}</time></td><td>${escape(f.name)}</td><td><span class="ct-cal-swatch ct-cal-${escape(f.colour)}" aria-hidden="true"></span>${escape(colourName(f.colour))}</td></tr>`).join('');
  const seasons=seasonRanges(year).map(s=>`<li><strong>${escape(s.name)}</strong>: <time datetime="${s.from}">${escape(shortDate(s.from))}</time> to <time datetime="${s.to}">${escape(shortDate(s.to))}</time>${s.note?` (${escape(s.note)})`:''}. Colour: ${escape(colourName(s.colour))}.</li>`).join('');
  return `<p class="ct-cal-intro">Principal feasts and seasons of the Western church year, worked out from the date of Easter. Orthodox Easter is shown for reference. Colours follow common Roman Catholic and Anglican usage; local practice varies, so check with your church.</p>`
    +(season?`<p class="ct-cal-today"><strong>Today in Lagos</strong> (<time datetime="${today}">${escape(longDate(today))}</time>): ${escape(season.feast?season.feast.name:season.name)}. Liturgical colour: ${escape(colourName(season.colour))}.</p>`:'')
    +`<nav class="ct-cal-years" aria-label="Other years">${nav}</nav>`
    +`<h2>Feasts and fasts</h2><table class="ct-cal-table"><caption class="ct-cal-sr">Principal feasts and fasts in ${year}</caption><thead><tr><th scope="col">Date</th><th scope="col">Observance</th><th scope="col">Colour</th></tr></thead><tbody>${feasts}</tbody></table>`
    +`<h2>Seasons</h2><ul class="ct-cal-seasons">${seasons}</ul>`
    +`<p class="ct-cal-note">Dates are calculated, not announced: Easter follows the Gregorian computus, Orthodox Easter the Julian computus shown in the Gregorian calendar. Advent Sunday is the fourth Sunday before Christmas Day; the Baptism of the Lord is the Sunday after the Epiphany.</p>`;
}

/**
 * Returns `async (url, respond) => boolean` handling {basePath}church-calendar/. Register it before the article slug
 * route in tools/serve-public.mjs.
 */
export function createChurchCalendarRoute({dist,siteUrl,basePath='/',indexable=false,extraHead='',now=()=>new Date()}){
  const path=`${basePath}church-calendar/`;
  return async function churchCalendar(url,respond){
    if(url.pathname!==path && url.pathname!==path.slice(0,-1))return false;
    if(url.pathname!==path){respond(308,'text/plain','Canonical page path',{Location:path+url.search});return true;}
    const year=calendarYear(url.searchParams,now());
    const defaultView=!url.search;
    const status=year===null?400:200;
    const title=year===null?'Church calendar: year not available':`Church calendar ${year}`;
    const description=year===null?`Choose a year from ${CALENDAR_MIN_YEAR} to ${CALENDAR_MAX_YEAR}.`:`Advent, Christmas, Lent, Holy Week, Easter, Pentecost and the other principal dates of the church year in ${year}.`;
    const canonical=status===200 && defaultView?siteCanonical(path,{siteUrl}):'';
    const robots=indexable && canonical?'index,follow':'noindex,follow';
    let html=await readFile(resolve(dist,'index.html'),'utf8');
    const assetPrefix=html.match(/href="(\.\/(?:site\/)?)assets\/[^"]+\.css"/)?.[1]||'./';
    html=html.replace(/<script\b[^>]*\btype="module"[^>]*>\s*<\/script>/g,'').replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g,'')
      .replace('<head>',`<head><base href="${escape(basePath)}">`)
      .replace(/<title>[^<]*<\/title>/,()=>`<title>${escape(title)} — ${SITE_NAME}</title>`)
      .replace(/(<meta name="description" content=")[^"]*(">)/,(_all,a,b)=>a+escape(description)+b);
    html=replaceSocialHTML(html,null,canonical).replace(/(property="og:title" content=")[^"]*"/,(_all,a)=>a+escape(title)+'"').replace(/(property="og:description" content=")[^"]*"/,(_all,a)=>a+escape(description)+'"');
    const body=year===null?`<p>${escape(description)}</p><p><a href="${escape(path)}">See this year’s calendar</a></p>`:calendarBody(year,{now:now(),path});
    html=html.replace('</head>',()=>`<meta name="robots" content="${robots}">${extraHead}<link rel="stylesheet" href="${escape(assetPrefix)}scripture/calendar.css">${canonical?`<link rel="canonical" href="${escape(canonical)}">`:''}</head>`)
      .replace('<div id="app"></div>',()=>`<div id="app"><header class="container ct-cal-header"><a class="ct-cal-home" href="${escape(basePath)}">${SITE_NAME}</a><nav aria-label="Site"><a href="${escape(basePath)}latest/">Latest</a><a href="${escape(basePath)}about/">About</a></nav></header><main id="main" class="container section-list ct-cal"><h1>${escape(title)}</h1>${body}</main></div>`);
    respond(status,'text/html; charset=utf-8',html,{'X-Robots-Tag':robots,'Cache-Control':status===200?'public, max-age=600':'no-store'});
    return true;
  };
}
