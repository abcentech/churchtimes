// Server-rendered topic pages: /topic/ (index) and /topic/{slug}/. Readable with no JavaScript; the browser app then
// re-renders the same view (adding the local "Follow" button) from the embedded JSON without a second CMS request.
// Registered with one line in tools/serve-public.mjs. Read-only: it only calls the anonymous public topics API.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {siteCanonical,escapeAttribute as escape,replaceSocialHTML,SITE_NAME} from '../../src/lib/public-metadata.js';
import {reportPath,articlePathTemplate as validateArticlePathTemplate,safeJSON} from '../../src/lib/public-routes.js';
import {cmsImage} from '../../src/lib/cms-media.js';
import {fetchTaxonomy,fetchTopicIndex,validTaxonomySlug} from '../../src/features/growth/taxonomy-api.js';

export const TOPIC_KIND_LABELS={topic:'Topic',denomination:'Denomination',series:'Series',ministry:'Ministry'};

/** `['index']`, `['topic', slug]`, `['invalid']` or null when the path is not a topic path. */
export function topicRoute(pathname,basePath='/') {
  if(!pathname.startsWith(basePath))return null;
  const relative=pathname.slice(basePath.length);
  if(relative==='topic' || relative==='topic/')return ['index'];
  const match=relative.match(/^topic\/([^/]+)\/?$/);
  if(!match)return relative.startsWith('topic/')?['invalid']:null;
  return validTaxonomySlug(match[1])?['topic',match[1]]:['invalid'];
}

const dateText=value=>{try{return value?new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'Africa/Lagos'}).format(new Date(value)):'';}catch{return '';}};
export function topicCardHTML(article,{basePath,articlePathTemplate}) {
  const href=escape(reportPath(article.slug,basePath,articlePathTemplate));
  return `<article class="story-card newsroom-card">${cmsImage(article.featuredImage,{card:true,fallbackAlt:article.title})}<div class="newsroom-card-meta">${article.category?`<span class="eyebrow clay">${escape(article.category)}</span>`:''}${article.publishedAt?`<time datetime="${escape(article.publishedAt)}">${escape(dateText(article.publishedAt))}</time>`:''}</div><h2><a href="${href}">${escape(article.title)}</a></h2>${article.excerpt?`<p>${escape(article.excerpt)}</p>`:''}</article>`;
}

export function topicSchema(topic,canonical,{siteUrl,basePath}) {
  const home=siteCanonical(basePath,{siteUrl}),index=siteCanonical(basePath+'topic/',{siteUrl});
  const crumbs=[['Home',home],['Topics',index],...(topic?[[topic.name,canonical]]:[])].filter(([,url])=>url);
  return [
    {'@context':'https://schema.org','@type':'CollectionPage',name:topic?topic.name:'Topics',...(topic?.description?{description:topic.description}:{}),...(canonical?{url:canonical}:{}),isPartOf:{'@type':'WebSite',name:SITE_NAME,...(home?{url:home}:{})}},
    ...(crumbs.length>1?[{'@context':'https://schema.org','@type':'BreadcrumbList',itemListElement:crumbs.map(([name,item],i)=>({'@type':'ListItem',position:i+1,name,item}))}]:[]),
  ];
}

export async function topicPages(url,respond,{dist,cmsUrl,siteUrl,basePath='/',indexable=false,fetchImpl=fetch,extraHead='',articlePathTemplate,lookupCache}) {
  const route=topicRoute(url.pathname,basePath);
  if(!route)return false;
  if(route[0]!=='invalid' && !url.pathname.endsWith('/')){respond(308,'text/plain','Canonical page path',{Location:url.pathname+'/'});return true;}
  const template=validateArticlePathTemplate(articlePathTemplate);
  const options={baseUrl:cmsUrl,fetchImpl,timeoutMs:6000};
  const cached=(key,load)=>lookupCache?lookupCache.get(key,load):load();
  let status=200,title,description,body='',topic=null,topics=null;
  try {
    if(!cmsUrl)throw new Error('not configured');
    if(route[0]==='invalid'){status=404;}
    else if(route[0]==='index') {
      topics=await cached('topic-index',()=>fetchTopicIndex(options));
      title='Topics';description='Browse Church Times Nigeria reporting by topic, denomination, series and ministry.';
      body=topics.length?`<ul class="growth-topic-index">${topics.map(t=>`<li><a href="${escape(basePath+'topic/'+t.slug+'/')}">${escape(t.name)}</a> <span>${escape(TOPIC_KIND_LABELS[t.kind])}</span></li>`).join('')}</ul>`:'<p>No topics have been published yet.</p>';
    } else {
      topic=await cached('topic:'+route[1],()=>fetchTaxonomy({...options,kind:'topic',slug:route[1]}));
      if(!topic)status=404;
      else {
        title=topic.name;description=topic.description || `Church Times Nigeria reporting on ${topic.name}.`;
        body=`<p class="eyebrow">${escape(TOPIC_KIND_LABELS[topic.kind])}</p>${topic.articles.length?`<div class="story-grid">${topic.articles.slice(0,20).map(a=>topicCardHTML(a,{basePath,articlePathTemplate:template})).join('')}</div>`:'<p>No published reports in this topic yet.</p>'}`;
      }
    }
    if(status===404){title='Topic unavailable';description='This topic is not available.';body=`<p><a href="${escape(basePath+'topic/')}">Browse all topics</a></p>`;}
  } catch {status=503;title='The newsroom is temporarily unavailable';description='Please try again later.';body='';}
  const canonical=status===200?siteCanonical(url.pathname,{siteUrl}):'';
  const robots=indexable && canonical?'index,follow':'noindex,nofollow';
  let html=await readFile(resolve(dist,'index.html'),'utf8');
  html=html.replace('<head>',`<head><base href="${escape(basePath)}">`)
    .replace(/<title>[^<]*<\/title>/,()=>`<title>${escape(title)} — ${SITE_NAME}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(">)/,(_all,a,b)=>a+escape(description)+b);
  html=replaceSocialHTML(html,null,canonical).replace(/(property="og:title" content=")[^"]*"/,(_all,a)=>a+escape(title)+'"').replace(/(property="og:description" content=")[^"]*"/,(_all,a)=>a+escape(description)+'"');
  const schema=status===200?`<script type="application/ld+json" data-public-metadata>${safeJSON(topicSchema(topic,canonical,{siteUrl,basePath}))}</script>`:'';
  // The browser app reuses this instead of fetching the topic again (same normalised, escaped-on-render data).
  const data=status===200&&topic?`<script id="public-topic" type="application/json">${safeJSON(topic)}</script>`:'';
  html=html.replace('</head>',()=>`<meta name="robots" content="${robots}">${extraHead}<meta name="public-article-path-template" content="${escape(template)}">${canonical?`<link rel="canonical" href="${escape(canonical)}">`:''}${schema}${data}</head>`)
    .replace('<div id="app"></div>',()=>`<div id="app"><main id="main" class="container section-list"><nav aria-label="Breadcrumb"><a href="${escape(basePath)}">Church Times Nigeria home</a>${route[0]==='topic'?` / <a href="${escape(basePath+'topic/')}">Topics</a>`:''}</nav><h1>${escape(title)}</h1><p>${escape(description)}</p>${body}</main></div>`);
  respond(status,'text/html; charset=utf-8',html,{'X-Robots-Tag':robots,...(status===503?{'Retry-After':'60'}:{})});
  return true;
}
