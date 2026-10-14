import {fetchLiveEvents,fetchLiveUpdates,liveSlug} from '../lib/public-live.js';
import {cmsErrorMessage} from '../lib/published-articles.js';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const timestamp=value=>new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Africa/Lagos'}).format(new Date(value))+' WAT';
export function livePageMarkup() {
 return `<section class="container section-list public-live" aria-labelledby="live-title"><span class="eyebrow clay">THE NEWSROOM</span><h1 id="live-title">Live coverage.</h1><p>Published updates from Church Times Nigeria, in publication order.</p><div id="live-discovery" aria-busy="true"><p role="status">Loading coverage…</p></div><section id="live-event" aria-labelledby="live-event-title" hidden><header><span class="live-badge" id="live-event-status"></span><h2 id="live-event-title"></h2><p id="live-event-summary"></p></header><div class="live-controls"><button class="outline-button" id="live-refresh" type="button">Refresh updates</button><button class="outline-button" id="live-pause" type="button" aria-pressed="false">Pause automatic updates</button><p id="live-check-time" class="small muted"></p></div><p id="live-announcement" role="status" aria-live="polite" aria-atomic="true"></p><div id="live-error" role="status" hidden></div><ol id="live-timeline" aria-label="Published updates"></ol><p id="live-empty" hidden>No updates have been published yet.</p><button id="live-more" class="outline-button" type="button" hidden>Load more published updates</button></section></section>`;
}
// One selected feed at a time. No interval, overlapping reads, hidden-tab polling or writes.
export function mountLivePage(root,{baseUrl,slug,signal,pollMs=15000,eventsReader=fetchLiveEvents,updatesReader=fetchLiveUpdates}={}) {
 const discovery=root.querySelector('#live-discovery');const panel=root.querySelector('#live-event');
 const errorBox=root.querySelector('#live-error');const announce=root.querySelector('#live-announcement');
 const refresh=root.querySelector('#live-refresh');const pause=root.querySelector('#live-pause');const more=root.querySelector('#live-more');
 let timer,busy=false,paused=false,ended=false,stopped=false,cursor=0,hasMore=false,failures=0;
 let selected=slug,allEvents=[],nextPage;const ids=new Set();const sequences=new Set();
 const controller=new AbortController();const alive=()=>!stopped&&root.isConnected;
 function stop(){stopped=true;clearTimeout(timer);controller.abort();document.removeEventListener('visibilitychange',visibility);signal?.removeEventListener('abort',stop);}
 signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted){stop();return stop;}
 function schedule(delay=pollMs){clearTimeout(timer);if(alive()&&!paused&&!ended&&!document.hidden)timer=setTimeout(()=>loadUpdates(),delay);}
 function failure(error){
  errorBox.hidden=false;errorBox.textContent=error?.status===404?'Coverage unavailable. This event is not available to readers.':`Updates could not be loaded. ${cmsErrorMessage(error)||'Please try again. Previously published updates remain here.'}`;
  if(error?.status===404){ended=true;cursor=0;hasMore=false;pause.hidden=true;more.hidden=true;announce.textContent='';root.querySelector('#live-event-status').textContent='Unavailable';root.querySelector('#live-event-title').textContent=root.querySelector('#live-event-title').textContent||'Coverage unavailable.';root.querySelector('#live-empty').hidden=true;clearTimeout(timer);root.querySelector('#live-timeline').replaceChildren();ids.clear();sequences.clear();}
 }
 async function loadUpdates(){
  if(!alive()||busy||!selected)return;
  busy=true;refresh.disabled=true;more.disabled=true;errorBox.hidden=true;panel.setAttribute('aria-busy','true');
  try {
   const data=await updatesReader({baseUrl,slug:selected,since:cursor,limit:50,signal:controller.signal});if(!alive())return;
   failures=0;ended=data.event.status==='ended';hasMore=data.hasMore;
   root.querySelector('#live-event-title').textContent=data.event.title;root.querySelector('#live-event-status').textContent=ended?'Coverage ended':'Live';
   const known=allEvents.find(e=>e.slug===selected);root.querySelector('#live-event-summary').textContent=known?.summary||'';
   const list=root.querySelector('#live-timeline');let added=0;
   for(const update of data.updates){
    if(ids.has(update.id)||sequences.has(update.sequence))continue;ids.add(update.id);sequences.add(update.sequence);added++;
    const row=document.createElement('li');row.dataset.sequence=String(update.sequence);
    const time=update.approvedAt||update.occurredAt;
    if(time){const label=document.createElement('p');label.className='live-update-time';const stamp=document.createElement('time');stamp.dateTime=time;stamp.textContent=timestamp(time);label.append(stamp);row.append(label);}
    const body=document.createElement('p');body.className='live-update-body';body.textContent=update.body;row.append(body);list.append(row);
   }
   cursor=data.nextSince;more.hidden=!hasMore;pause.hidden=ended;
   root.querySelector('#live-empty').hidden=ids.size>0;
   root.querySelector('#live-check-time').textContent=`Last checked ${timestamp(new Date().toISOString())}`;
   if(added||!ids.size||ended)announce.textContent=ended?`Coverage ended. ${ids.size} published updates shown.`:added?`${added} new ${added===1?'update':'updates'}. ${ids.size} published updates shown.`:'Waiting for the first published update.';
   schedule(hasMore?1000:pollMs);
  }catch(error){if(!alive())return;failures++;failure(error);schedule(error?.status===429?Math.max(1000,error.retryAfter*1000):Math.min(120000,pollMs*2**Math.min(failures,3)));}
  finally{busy=false;if(alive()){refresh.disabled=false;more.disabled=false;panel.setAttribute('aria-busy','false');}}
 }
 async function loadDiscovery(page=1){
  if(!alive())return;const focusInside=discovery.contains(document.activeElement);const previousCount=allEvents.length;discovery.setAttribute('aria-busy','true');discovery.querySelector('button')?.setAttribute('disabled','');
  try {
   const data=await eventsReader({baseUrl,page,signal:controller.signal});if(!alive())return;
   for(const event of data.events)if(!allEvents.some(e=>e.slug===event.slug))allEvents.push(event);
   nextPage=data.nextPage;
   discovery.innerHTML=allEvents.length?`<nav aria-label="Live and ended coverage"><ul class="live-event-links">${allEvents.map(event=>`<li><a href="#live/${escape(event.slug)}" ${event.slug===selected?'aria-current="page"':''}>${escape(event.title)} <span>${event.status==='live'?'Live':'Ended'}</span></a></li>`).join('')}</ul></nav>${nextPage?'<button class="outline-button" id="live-more-events">More coverage</button>':''}`:'<p>No live or ended coverage is available yet.</p>';
   discovery.querySelector('#live-more-events')?.addEventListener('click',()=>loadDiscovery(nextPage));
   if(!selected)selected=(allEvents.find(event=>event.status==='live')||allEvents[0])?.slug;
   discovery.querySelectorAll('a').forEach(link=>{if(link.getAttribute('href')===`#live/${selected}`)link.setAttribute('aria-current','page');});
   if(selected&&panel.hidden){panel.hidden=false;await loadUpdates();}
   if(focusInside)(discovery.querySelectorAll('a')[previousCount]||discovery.querySelector('a'))?.focus();
  }catch(error){
   if(!alive())return;
   if(allEvents.length){discovery.querySelector('#live-discovery-failure')?.remove();discovery.querySelector('#live-more-events')?.remove();discovery.insertAdjacentHTML('beforeend','<div id="live-discovery-failure"><p>More coverage could not be loaded.</p><button id="live-discovery-retry" class="outline-button">Try again</button></div>');}
   else discovery.innerHTML=`<p>${escape(cmsErrorMessage(error)||'Coverage could not be loaded. Please try again.')}</p><button id="live-discovery-retry" class="outline-button">Try again</button>`;
   discovery.querySelector('#live-discovery-retry')?.addEventListener('click',()=>loadDiscovery(page));
  }finally{if(alive())discovery.setAttribute('aria-busy','false');}
 }
 function visibility(){clearTimeout(timer);if(!document.hidden)schedule(hasMore?1000:pollMs);}
 document.addEventListener('visibilitychange',visibility);
 refresh.addEventListener('click',()=>{clearTimeout(timer);loadUpdates();});more.addEventListener('click',()=>{clearTimeout(timer);loadUpdates();});
 pause.addEventListener('click',()=>{paused=!paused;pause.setAttribute('aria-pressed',String(paused));pause.textContent=paused?'Resume automatic updates':'Pause automatic updates';clearTimeout(timer);if(!paused)schedule();});
 if(!baseUrl){discovery.innerHTML='<p>Live coverage is not available yet. Browse the current edition or the latest published reports.</p>';discovery.setAttribute('aria-busy','false');}
 else if(slug&&!liveSlug(slug)){discovery.innerHTML='<p>Coverage unavailable. Check the event link.</p>';discovery.setAttribute('aria-busy','false');}
 else {if(slug){panel.hidden=false;loadUpdates();}loadDiscovery();}
 return stop;
}
