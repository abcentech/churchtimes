// Liturgical-year calculator: pure date arithmetic, no dependencies, no network. Works in node and the browser.
// Dates are ISO calendar dates ('YYYY-MM-DD'); "today" is the civil date in Lagos (WAT, UTC+1, no daylight saving).
// Seasons and colours follow common Western (Roman Catholic / Anglican Revised Common Lectionary) usage;
// local practice varies, so pages present them as a guide.
// The Gregorian computus holds from 1583; the range stops where Julian/Gregorian offsets would need more care.
export const MIN_YEAR=1583,MAX_YEAR=4099;
const DAY=86400000;
const pad=n=>String(n).padStart(2,'0');
const iso=date=>`${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())}`;
const utc=(y,m,d)=>new Date(Date.UTC(y,m-1,d));
const addDays=(date,days)=>new Date(date.getTime()+days*DAY);
const validYear=year=>Number.isInteger(year) && year>=MIN_YEAR && year<=MAX_YEAR;
function assertYear(year){if(!validYear(year))throw new RangeError(`Year must be an integer from ${MIN_YEAR} to ${MAX_YEAR}`);}
function toDate(value){
  if(value instanceof Date)return utc(value.getUTCFullYear(),value.getUTCMonth()+1,value.getUTCDate());
  const match=typeof value==='string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!match)throw new TypeError('Expected an ISO date (YYYY-MM-DD)');
  const date=utc(+match[1],+match[2],+match[3]);
  if(iso(date)!==value)throw new RangeError('Invalid calendar date');
  return date;
}

/** Civil date in Lagos (UTC+1 all year) for an instant. */
export const lagosDate=(now=new Date())=>iso(new Date(now.getTime()+3600000));

/** Western (Gregorian) Easter Day: the Anonymous Gregorian algorithm (Meeus/Jones/Butcher). */
export function westernEaster(year){
  assertYear(year);
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3);
  const h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
  const month=Math.floor((h+l-7*m+114)/31),day=((h+l-7*m+114)%31)+1;
  return iso(utc(year,month,day));
}

/** Orthodox Easter (Julian computus, Meeus), expressed as a Gregorian date. */
export function orthodoxEaster(year){
  assertYear(year);
  const a=year%4,b=year%7,c=year%19,d=(19*c+15)%30,e=(2*a+4*b-d+34)%7;
  const month=Math.floor((d+e+114)/31),day=((d+e+114)%31)+1;
  // Julian-to-Gregorian offset for dates after 28 February of the year (13 days for 1900-2099).
  const offset=Math.floor(year/100)-Math.floor(year/400)-2;
  return iso(addDays(utc(year,month,day),offset));
}

/** Advent Sunday: the fourth Sunday before Christmas Day (27 November to 3 December). */
export function adventSunday(year){
  assertYear(year);
  const christmas=utc(year,12,25),weekday=christmas.getUTCDay();
  return iso(addDays(christmas,-(weekday===0?7:weekday)-21));
}

/** Baptism of the Lord: the Sunday after the Epiphany (7 to 13 January). */
export function baptismOfTheLord(year){
  assertYear(year);
  const seventh=utc(year,1,7);
  return iso(addDays(seventh,(7-seventh.getUTCDay())%7));
}

const COLOURS={purple:'Purple',white:'White',green:'Green',red:'Red',rose:'Rose'};
export const SEASONS={
  advent:{name:'Advent',colour:'purple'},
  christmas:{name:'Christmas',colour:'white'},
  epiphany:{name:'Epiphany',colour:'white'},
  ordinary:{name:'Ordinary Time',colour:'green'},
  lent:{name:'Lent',colour:'purple'},
  'holy-week':{name:'Holy Week',colour:'red'},
  easter:{name:'Easter',colour:'white'},
};
export const colourName=colour=>COLOURS[colour]||'';

/** Principal feasts and fasts of the civil year, in date order. */
export function liturgicalYear(year){
  assertYear(year);
  const easter=toDate(westernEaster(year)),rel=days=>iso(addDays(easter,days));
  const feasts=[
    {key:'epiphany',name:'The Epiphany',date:`${year}-01-06`,colour:'white'},
    {key:'baptism',name:'The Baptism of the Lord',date:baptismOfTheLord(year),colour:'white'},
    {key:'ash-wednesday',name:'Ash Wednesday',date:rel(-46),colour:'purple'},
    {key:'palm-sunday',name:'Palm Sunday',date:rel(-7),colour:'red'},
    {key:'maundy-thursday',name:'Maundy Thursday',date:rel(-3),colour:'white'},
    {key:'good-friday',name:'Good Friday',date:rel(-2),colour:'red'},
    {key:'holy-saturday',name:'Holy Saturday',date:rel(-1),colour:'purple'},
    {key:'easter',name:'Easter Day',date:rel(0),colour:'white'},
    {key:'orthodox-easter',name:'Orthodox Easter (Pascha)',date:orthodoxEaster(year),colour:'white'},
    {key:'ascension',name:'Ascension Day',date:rel(39),colour:'white'},
    {key:'pentecost',name:'Pentecost',date:rel(49),colour:'red'},
    {key:'trinity',name:'Trinity Sunday',date:rel(56),colour:'white'},
    {key:'advent-sunday',name:'Advent Sunday (first Sunday of Advent)',date:adventSunday(year),colour:'purple'},
    {key:'christmas',name:'Christmas Day',date:`${year}-12-25`,colour:'white'},
  ];
  return feasts.sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
}

/**
 * Season (and feast, if any) for a date. Boundaries: Christmas 25 Dec-5 Jan; Epiphany 6 Jan-Baptism of the Lord;
 * Ordinary Time to Shrove Tuesday; Lent Ash Wednesday-Saturday before Palm Sunday; Holy Week Palm Sunday-Holy
 * Saturday; Easter Easter Day-Pentecost; Ordinary Time to the eve of Advent Sunday; Advent to Christmas Eve.
 */
export function seasonFor(value=lagosDate()){
  const date=toDate(value),year=date.getUTCFullYear();
  assertYear(year);
  const day=iso(date),easter=toDate(westernEaster(year));
  const rel=days=>iso(addDays(easter,days));
  let key;
  if(day>=`${year}-12-25` || day<=`${year}-01-05`)key='christmas';
  else if(day>=adventSunday(year))key='advent';
  else if(day<=baptismOfTheLord(year))key='epiphany';
  else if(day<rel(-46))key='ordinary';
  else if(day<rel(-7))key='lent';
  else if(day<rel(0))key='holy-week';
  else if(day<=rel(49))key='easter';
  else key='ordinary';
  const feast=liturgicalYear(year).find(f=>f.date===day && f.key!=='orthodox-easter')||null;
  const season=SEASONS[key];
  return {key,name:season.name,colour:feast?.colour||season.colour,date:day,feast};
}
