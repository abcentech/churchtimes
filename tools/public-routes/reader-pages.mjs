// Server-rendered author and trust pages: /author/{slug}/, /about/editorial-standards/, /about/ownership/, /corrections/.
// Complete without JavaScript. The page data is embedded (#public-reader-page) so the lazy client view
// (src/features/reader/reader-pages.js) takes over without fetching again. Also supplies the article furniture
// stylesheet for server-rendered article pages. Data: apps/cms/docs/w12/schema-contract.md section 3 (anonymous reads).
import {readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {publicPageRoute} from '../../src/lib/public-page-routes.js';
import {siteCanonical,escapeAttribute as escape,replaceSocialHTML,SITE_NAME} from '../../src/lib/public-metadata.js';
import {reportPath,articlePathTemplate as validateArticlePathTemplate,safeJSON} from '../../src/lib/public-routes.js';
import {loadReaderPage,renderReaderPage,readerPageKey,pageNumber,fetchPublicJSON,normalizeSiteTrust,TRUST_PAGES} from '../../src/lib/reader-pages.js';
import {createLookupCache} from '../public-lookup-cache.mjs';

// The furniture stylesheet is a hashed lazy asset; find it once by a selector only it defines.
export function createReaderStylesheet(dist) {
  let pending;
  return ()=>pending ||= (async()=>{
    for(const [folder,href] of [[join(dist,'site','assets'),'site/assets/'],[join(dist,'assets'),'assets/']]) {
      let names;try{names=await readdir(folder);}catch{continue;}
      for(const name of names.filter(n=>/^[\w.-]+\.css$/.test(n)).sort())if((await readFile(join(folder,name),'utf8')).includes('.reader-keypoints'))return `<link rel="stylesheet" href="${escape(href+name)}">`;
    }
    return '';
  })().catch(()=>'');
}

export function createReaderPages({dist,cmsUrl,siteUrl,basePath='/',indexable=false,fetchImpl=fetch,articlePathTemplate,extraHead='',lookupCache=createLookupCache({ttlMs:60000,negativeTtlMs:15000}),stylesheet=createReaderStylesheet(dist)}) {
  const template=validateArticlePathTemplate(articlePathTemplate);
  return async function readerPages(url,respond) {
    const route=publicPageRoute(url.pathname,basePath);
    const key=route?readerPageKey(route[0],route[1]):'';
    if(!key)return false;
    if(!url.pathname.endsWith('/')){respond(308,'text/plain','Canonical page path',{Location:url.pathname+'/'});return true;}
    const page=pageNumber(url.searchParams.get('page')),param=route[1]||'';
    let status=200,view,result;
    try {
      if(!cmsUrl)throw new Error('not configured');
      result=await lookupCache.get(`reader:${key}:${param}:${page}`,()=>loadReaderPage(key,{cmsUrl,slug:param,page,fetchImpl,timeoutMs:6000}));
      status=result.status;
    } catch {status=503;}
    if(status===200)view=renderReaderPage(key,result.data,{base:basePath,baseUrl:cmsUrl,articleHref:slug=>reportPath(slug,basePath,template),canonical:path=>siteCanonical(path,{siteUrl})});
    else {
      const title=status===404?(key==='author'?'Author unavailable':'Page not published yet'):'The newsroom is temporarily unavailable';
      const message=status===404?(key==='author'?'This author profile is not available.':'This page has not been published by the newsroom yet.'):'Please try again later.';
      view={title,description:message,html:`<h1>${escape(title)}</h1><p>${escape(message)}</p>`};
    }
    // Page 2+ is a listing continuation: indexable pages are page 1 only.
    const canonical=status===200?siteCanonical(url.pathname,{siteUrl}):'';
    const robots=indexable && canonical && page===1?'index,follow':'noindex,nofollow';
    let html=await readFile(resolve(dist,'index.html'),'utf8');
    html=html.replace('<head>',`<head><base href="${escape(basePath)}">`)
      .replace(/<title>[^<]*<\/title>/,()=>`<title>${escape(view.title)} — ${SITE_NAME}</title>`)
      .replace(/(<meta name="description" content=")[^"]*(">)/,(_all,a,b)=>a+escape(view.description)+b);
    html=replaceSocialHTML(html,null,canonical).replace(/(property="og:title" content=")[^"]*"/,(_all,a)=>a+escape(view.title)+'"').replace(/(property="og:description" content=")[^"]*"/,(_all,a)=>a+escape(view.description)+'"');
    if(key==='author'&&status===200)html=html.replace('property="og:type" content="website"','property="og:type" content="profile"');
    const data=status===503?'':`<script id="public-reader-page" type="application/json">${safeJSON({key,param,page,status,data:result.data})}</script>`;
    const schema=view.schema?`<script id="article-schema" type="application/ld+json">${safeJSON(view.schema)}</script>`:'';
    const sheet=await stylesheet();
    html=html.replace('</head>',()=>`<meta name="robots" content="${robots}">${extraHead}<meta name="public-article-path-template" content="${escape(template)}">${canonical?`<link rel="canonical" href="${escape(canonical)}">`:''}${sheet}${data}${schema}</head>`)
      .replace('<div id="app"></div>',()=>`<div id="app"><main id="main" class="container section-list reader-page"><a href="${escape(basePath)}">Church Times Nigeria home</a>${view.html}</main></div>`);
    respond(status,'text/html; charset=utf-8',html,{'X-Robots-Tag':robots,...(status===503?{'Retry-After':'60'}:{})});
    return true;
  };
}

// Trust page URLs for the sitemap: corrections always, the others once the newsroom has published them.
export async function readerSitemapPaths({cmsUrl,fetchImpl=fetch}) {
  if(!cmsUrl)return [];
  const [trust,authors]=await Promise.all([fetchPublicJSON(cmsUrl,'/api/public/site-trust',{fetchImpl}).then(normalizeSiteTrust),fetchPublicJSON(cmsUrl,'/api/public/authors',{fetchImpl})]);
  const pages=Object.values(TRUST_PAGES).filter(page=>page.field==='ethicsCorrectionsPolicy'||trust?.[page.field]).map(page=>page.path);
  const slugs=(Array.isArray(authors?.docs)?authors.docs:[]).slice(0,200).filter(author=>typeof author?.name==='string'&&typeof author.slug==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(author.slug)).map(author=>author.slug);
  return [...pages,...slugs.map(slug=>`author/${slug}/`)];
}
