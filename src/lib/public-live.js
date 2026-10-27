import {publicOrigin} from './public-url.js';
import {CMSReadError,normalizePublicMedia} from './published-articles.js';
export const MAX_LIVE_RETRY_SECONDS=600;
const text=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
export const liveSlug=value=>typeof value==='string'&&value.length<=160&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():'';
export function normalizeLiveEvent(value) {
 if(!value||!liveSlug(value.slug)||!['live','ended'].includes(value.status)||!text(value.title,240))return null;
 return {slug:value.slug,title:text(value.title,240),status:value.status,summary:text(value.summary,1000),startedAt:date(value.startedAt),endedAt:date(value.endedAt)};
}
export function normalizeLiveUpdate(value,{baseUrl}={}) {
 if(!value||!positive(value.sequence)||!/^\d{1,15}$/.test(String(value.id))||typeof value.body!=='string'||!value.body.trim()||(value.status!==undefined&&value.status!=='approved'))return null;
 const origin=publicOrigin(baseUrl);
 const media=origin && normalizePublicMedia(value.image,origin);
 const image=media && text(value.image?.alt,300) ? {url:media.url,alt:text(value.image.alt,300),width:positive(value.image.width)?value.image.width:null,height:positive(value.image.height)?value.image.height:null,mimeType:value.image.mimeType} : null;
 return {id:String(value.id),sequence:value.sequence,image,body:text(value.body,5000),occurredAt:date(value.occurredAt),approvedAt:date(value.approvedAt)};
}
async function read(path,{baseUrl,signal,fetchImpl=fetch,timeoutMs=6000}={}) {
 const origin=publicOrigin(baseUrl);if(!origin)throw new CMSReadError('configuration','Invalid public CMS origin');
 const controller=new AbortController();let timedOut=false;
 const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(()=>{timedOut=true;abort();},timeoutMs);
 try {
  if(signal?.aborted)throw Error('cancelled');
  const response=await fetchImpl(new URL(path,origin).href,{method:'GET',headers:{Accept:'application/json'},credentials:'omit',cache:'no-store',signal:controller.signal});
  if(!response.ok){const error=new CMSReadError('http','Public live request failed',response.status);const raw=response.headers?.get('Retry-After');const delay=raw&&/^\d+$/.test(raw)?Number(raw):Math.ceil((Date.parse(raw)-Date.now())/1000);error.retryAfter=Number.isFinite(delay)&&delay>0?Math.min(MAX_LIVE_RETRY_SECONDS,delay):30;throw error;}
  try{return await response.json();}catch(error){if(controller.signal.aborted)throw error;throw new CMSReadError('response','Unreadable live response');}
 }catch(error){
  if(error instanceof CMSReadError)throw error;
  throw new CMSReadError(signal?.aborted?'cancelled':timedOut?'timeout':'network','Public live request unavailable');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function fetchLiveEvents({page=1,...options}={}) {
 const query=new URLSearchParams({'where[status][in]':'live,ended',sort:'-startedAt',depth:'0',limit:'12',page:String(Math.max(1,Math.floor(Number(page))||1))});
 const payload=await read('/api/live-events?'+query,options);
 if(!Array.isArray(payload?.docs))throw new CMSReadError('response','Invalid live discovery response');
 return {events:payload.docs.map(normalizeLiveEvent).filter(Boolean),nextPage:payload.hasNextPage===true&&Number.isSafeInteger(payload.nextPage)&&payload.nextPage>Number(query.get('page'))?payload.nextPage:null};
}
export async function fetchLiveUpdates({slug,since=0,limit=50,...options}={}) {
 if(!liveSlug(slug)||!Number.isSafeInteger(since)||since<0||since>999999999999999||!Number.isInteger(limit)||limit<1||limit>100)throw new CMSReadError('configuration','Invalid live cursor or slug');
 const payload=await read(`/api/live-events/${slug}/updates?${new URLSearchParams({since:String(since),limit:String(limit)})}`,options);
 const event=normalizeLiveEvent(payload?.event);
 if(!event||event.slug!==slug||!Array.isArray(payload.docs)||!Number.isSafeInteger(payload.nextSince)||payload.nextSince<since||payload.nextSince>999999999999999)throw new CMSReadError('response','Invalid live feed response');
 const updates=payload.docs.map(value=>normalizeLiveUpdate(value,{baseUrl:options.baseUrl}));
 if(updates.some(update=>!update||update.sequence<=since||update.sequence>payload.nextSince)||payload.nextSince!==Math.max(since,...updates.filter(Boolean).map(update=>update.sequence)))throw new CMSReadError('response','Invalid live publication cursor');
 return {event,updates:updates.sort((a,b)=>a.sequence-b.sequence),nextSince:payload.nextSince,hasMore:payload.docs.length>=limit};
}
