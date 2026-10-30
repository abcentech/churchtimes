// Server-rendered shells for /give/ and /give/thanks/ (docs/w12/giving.md). The page is readable without JavaScript;
// the form itself is the lazy chunk src/features/giving/give-page.js, because a gift needs the CMS and Turnstile anyway.
// /give/ is a 404 unless the CMS reports giving as enabled. /give/thanks/ always answers (a reader returning from Paystack
// must be told what happened even if giving was switched off meanwhile); it is never indexed, cached or sent as a referrer.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {publicPageRoute} from '../../src/lib/public-page-routes.js';
import {siteCanonical,escapeAttribute as escape,replaceSocialHTML,SITE_NAME} from '../../src/lib/public-metadata.js';
import {articlePathTemplate as validateArticlePathTemplate} from '../../src/lib/public-routes.js';
import {publicOrigin} from '../../src/lib/public-url.js';
import {createLookupCache} from '../public-lookup-cache.mjs';

export async function fetchGivingSettings({cmsUrl,fetchImpl=fetch,timeoutMs=4000}) {
  const origin=publicOrigin(cmsUrl);
  if(!origin)return null;
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const response=await fetchImpl(`${origin}/api/public/giving/settings`,{headers:{Accept:'application/json'},redirect:'error',signal:controller.signal});
    if(!response.ok)throw new Error(`giving settings ${response.status}`);
    const data=await response.json();
    return data?.enabled===true?data:{enabled:false};
  } finally {clearTimeout(timer);}
}

const para=text=>escape(text).split(/\n{2,}/).map(p=>`<p>${p.replace(/\n/g,'<br>')}</p>`).join('');
const NOSCRIPT='<noscript><p>Giving needs JavaScript to open Paystack’s secure checkout. You can still give by bank transfer using the details on this page, or contact the newsroom.</p></noscript>';

export function createGivingRoutes({dist,cmsUrl,siteUrl,basePath='/',indexable=false,fetchImpl=fetch,articlePathTemplate,extraHead='',lookupCache=createLookupCache({ttlMs:60000,negativeTtlMs:30000})}) {
  return async function givingRoutes(url,respond) {
    const route=publicPageRoute(url.pathname,basePath);
    if(!route || route[0]!=='give')return false;
    if(!url.pathname.endsWith('/')){respond(308,'text/plain','Canonical page path',{Location:url.pathname+'/'});return true;}
    const thanks=route[1]==='thanks';
    let settings=null,status=200;
    try {settings=cmsUrl?await lookupCache.get('giving:settings',()=>fetchGivingSettings({cmsUrl,fetchImpl})):null;}
    catch {status=thanks?200:503;}
    const enabled=settings?.enabled===true;
    if(!thanks && status===200 && !enabled)status=404;
    let title,description,body;
    if(thanks) {
      title='Your gift';description='Confirmation of your gift to Church Times Nigeria.';
      body=`<span class="eyebrow">SUPPORT OUR JOURNALISM</span><h1>Checking your payment…</h1><p>We confirm every gift with Paystack before we call it received. This page updates automatically.</p>${NOSCRIPT.replace('You can still give by bank transfer using the details on this page, or contact the newsroom.','Your receipt arrives by email once the payment is confirmed.')}`;
    } else if(status===200) {
      title='Support our journalism';description='Give to Church Times Nigeria: one-time gifts by card, bank transfer or USSD through Paystack.';
      body=`<span class="eyebrow">SUPPORT OUR JOURNALISM</span><h1>Keep independent reporting free to read.</h1><p>Church Times Nigeria is reader-supported. A one-time gift helps us report on the church and public life with care and independence.</p><p>You pay on Paystack’s secure page by card, bank transfer or USSD. We never see or store your card details.</p>${settings.bankTransferNote?`<h2>Other ways to give</h2>${para(settings.bankTransferNote)}`:''}${NOSCRIPT}`;
    } else {
      title=status===404?'Online giving is not available':'Giving is temporarily unavailable';description='Please try again later.';
      body=`<h1>${escape(title)}</h1><p>Thank you for thinking of us. Please try again later or contact the newsroom.</p>`;
    }
    const canonical=!thanks && status===200?siteCanonical(url.pathname,{siteUrl}):'';
    const robots=indexable && canonical?'index,follow':'noindex,nofollow';
    let html=await readFile(resolve(dist,'index.html'),'utf8');
    html=html.replace('<head>',`<head><base href="${escape(basePath)}">`)
      .replace(/<title>[^<]*<\/title>/,()=>`<title>${escape(title)} — ${SITE_NAME}</title>`)
      .replace(/(<meta name="description" content=")[^"]*(">)/,(_all,a,b)=>a+escape(description)+b);
    html=replaceSocialHTML(html,null,canonical).replace(/(property="og:title" content=")[^"]*"/,(_all,a)=>a+escape(title)+'"').replace(/(property="og:description" content=")[^"]*"/,(_all,a)=>a+escape(description)+'"');
    html=html.replace('</head>',()=>`<meta name="robots" content="${robots}">${extraHead}<meta name="public-article-path-template" content="${escape(validateArticlePathTemplate(articlePathTemplate))}">${canonical?`<link rel="canonical" href="${escape(canonical)}">`:''}</head>`)
      .replace('<div id="app"></div>',()=>`<div id="app"><main id="main" class="container give-page"><a href="${escape(basePath)}">Church Times Nigeria home</a>${body}</main></div>`);
    const headers={'X-Robots-Tag':robots,'Referrer-Policy':thanks?'no-referrer':'strict-origin-when-cross-origin',...(thanks?{'Cache-Control':'no-store'}:{}),...(status===503?{'Retry-After':'60'}:{})};
    respond(status,'text/html; charset=utf-8',html,headers);return true;
  };
}
