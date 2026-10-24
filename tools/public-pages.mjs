import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fetchPublishedPage,fetchPublicCategory} from '../src/lib/published-articles.js';
import {publicPageRoute} from '../src/lib/public-page-routes.js';
import {siteCanonical,escapeAttribute as escape,replaceSocialHTML,SITE_NAME} from '../src/lib/public-metadata.js';
import {reportPath,articlePathTemplate as validateArticlePathTemplate} from '../src/lib/public-routes.js';
import {cmsImage} from '../src/lib/cms-media.js';
const staticPages={
  about:{title:'About Church Times Nigeria',description:'Professional journalism on the church, the people and the world we share.',body:'Church Times Nigeria is a publication of Churchtimes Agency Ltd. Its published mission reaches across politics, business, education, health and other spheres of life.'},
  contact:{title:'Contact the newsroom',description:'News tips, reader correspondence and commercial enquiries for Church Times Nigeria.',body:'For a news tip or correction, include the relevant article link and enough detail for the newsroom to understand your enquiry.'},
  advertise:{title:'Advertise with Church Times',description:'Talk to the publication about print and digital advertising, publishing projects and special editions.',body:'Contact the publication to confirm current options, availability, pricing and tax treatment. Request written deliverables and clear advertising labels before committing.'},
};
export function createPublicPages({dist,cmsUrl,siteUrl,basePath,indexable,fetchImpl,articlePathTemplate,extraHead=''}) {
  return async function publicPages(url,respond) {
    const route=publicPageRoute(url.pathname,basePath);if(!route)return false;
    if(!url.pathname.endsWith('/')){respond(308,'text/plain','Canonical page path',{Location:url.pathname+'/'});return true;}
    let status=200,title,description,body;
    try {
      const [name,slug]=route;
      if(staticPages[name]) {
        ({title,description}=staticPages[name]);
        body=`<p>${escape(staticPages[name].body)}</p>${name==='about'?'':`<p><a href="mailto:info@churchtimesnigeria.net">info@churchtimesnigeria.net</a></p>`}`;
      } else {
        const options={baseUrl:cmsUrl,fetchImpl,timeoutMs:6000};
        const category=name==='category'?await fetchPublicCategory({...options,slug}):null;
        if(name==='category'&&!category){status=404;title='Section unavailable';description='This section is not available.';body='';}
        else {
          title=category?.title || 'The latest reports';description=category?.description || 'Published reporting from Church Times Nigeria.';
          const {articles}=await fetchPublishedPage({...options,limit:20,...(category?{categoryId:category.id}:{})});
          body=`<div class="story-grid">${articles.map(article=>`<article class="story-card newsroom-card">${cmsImage(article.featuredImage,{card:true,fallbackAlt:article.title})}<h2><a href="${escape(reportPath(article.slug,basePath,articlePathTemplate))}">${escape(article.title)}</a></h2><p>${escape(article.excerpt)}</p></article>`).join('')}</div>`;
        }
      }
    } catch {status=503;title='The newsroom is temporarily unavailable';description='Please try again later.';body='';}
    const canonical=status===200?siteCanonical(url.pathname,{siteUrl}):'';
    const robots=indexable && canonical?'index,follow':'noindex,nofollow';
    let html=await readFile(resolve(dist,'index.html'),'utf8');
    html=html.replace('<head>',`<head><base href="${escape(basePath)}">`)
      .replace(/<title>[^<]*<\/title>/,()=>`<title>${escape(title)} — ${SITE_NAME}</title>`)
      .replace(/(<meta name="description" content=")[^"]*(">)/,(_all,a,b)=>a+escape(description)+b);
    html=replaceSocialHTML(html,null,canonical).replace(/(property="og:title" content=")[^"]*"/,(_all,a)=>a+escape(title)+'"').replace(/(property="og:description" content=")[^"]*"/,(_all,a)=>a+escape(description)+'"');
    html=html.replace('</head>',()=>`<meta name="robots" content="${robots}">${extraHead}<meta name="public-article-path-template" content="${escape(validateArticlePathTemplate(articlePathTemplate))}">${canonical?`<link rel="canonical" href="${escape(canonical)}">`:''}</head>`)
      .replace('<div id="app"></div>',()=>`<div id="app"><main id="main" class="container section-list"><a href="${escape(basePath)}">Church Times Nigeria home</a><h1>${escape(title)}</h1><p>${escape(description)}</p>${body}</main></div>`);
    respond(status,'text/html; charset=utf-8',html,{'X-Robots-Tag':robots});return true;
  };
}
