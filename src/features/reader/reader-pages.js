// Lazy client view for author and trust pages. On a first load the public host has already rendered the page and
// embedded its data (#public-reader-page), so nothing is fetched twice; client navigations fetch the same endpoints.
import './reader-article.css';
import {loadReaderPage,renderReaderPage,readerPageKey,pageNumber} from '../../lib/reader-pages.js';
import {cmsErrorMessage} from '../../lib/published-articles.js';
import {bindCMSImages} from '../../lib/cms-media.js';
import {reportPath,safeJSON} from '../../lib/public-routes.js';
import {siteCanonical} from '../../lib/public-metadata.js';

function serverData(key,param,page) {
  const element=document.querySelector('#public-reader-page');
  if(!element)return null;
  element.remove();
  try {const data=JSON.parse(element.textContent);return data?.key===key&&data.param===param&&data.page===page?data:null;} catch {return null;}
}
function setMeta(title,description) {
  document.title=`${title} — Church Times Nigeria`;
  for(const [selector,value] of [['meta[name="description"]',description],['meta[property="og:title"]',title],['meta[property="og:description"]',description]]){const meta=document.querySelector(selector);if(meta)meta.content=value;}
}
export async function mountReaderPage(target,{kind,param='',cmsUrl,signal,base='/',siteUrl,search=location.search}) {
  const key=readerPageKey(kind,param),page=pageNumber(new URLSearchParams(search).get('page'));
  const state=(title,message,retry)=>{
    target.innerHTML=`<div class="newsroom-state"><h1 tabindex="-1">${title}</h1><p role="status">${message}</p>${retry?'<div class="newsroom-state-actions"><button class="outline-button" type="button">Try again</button></div>':''}</div>`;
    target.querySelector('button')?.addEventListener('click',retry);
    document.title=`${title} — Church Times Nigeria`;
  };
  target.setAttribute('aria-busy','true');
  try {
    if(!key){state('Page unavailable.','This page is not available.');return false;}
    let result=serverData(key,param,page);
    if(!result) {
      if(!cmsUrl){state('The newsroom is taking shape.','This page will be available when the newsroom connection is configured.');return;}
      target.innerHTML='<p role="status">Loading…</p>';
      result=await loadReaderPage(key,{cmsUrl,slug:param,page,signal});
    }
    if(signal?.aborted || !target.isConnected)return false;
    if(result.status!==200){state(key==='author'?'Author unavailable.':'Page not published yet.',key==='author'?'This author profile is not available.':'This page has not been published by the newsroom yet.');return;}
    const view=renderReaderPage(key,result.data,{base,baseUrl:cmsUrl,articleHref:slug=>reportPath(slug,base),canonical:path=>siteCanonical(path,{siteUrl})});
    target.innerHTML=view.html;
    bindCMSImages(target);
    setMeta(view.title,view.description);
    document.querySelector('#article-schema')?.remove();
    const schema=document.createElement('script');schema.id='article-schema';schema.type='application/ld+json';schema.textContent=safeJSON(view.schema);document.head.append(schema);
  } catch(error) {
    if(signal?.aborted || !target.isConnected)return false;
    state('We couldn’t load this page.',cmsErrorMessage(error)||'Please try again later.',()=>mountReaderPage(target,{kind,param,cmsUrl,signal,base,siteUrl,search}));
  } finally {if(target.isConnected)target.setAttribute('aria-busy','false');}
}
// Entry point from src/main.js renderRoute(). "signal" belongs to the navigation that asked for this page; "route()" is the
// controller after shell() starts this page. A superseded navigation never paints.
export function readerRoute(kind,param,{shell,cmsUrl,base,signal,route}) {
  if(signal.aborted)return false;
  shell('<section class="container section-list reader-page" id="reader-page" aria-busy="true"></section>',kind);
  return mountReaderPage(document.querySelector('#reader-page'),{kind,param,cmsUrl,signal:route(),base,siteUrl:import.meta.env.VITE_PUBLIC_SITE_URL});
}
