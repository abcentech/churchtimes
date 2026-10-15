// Optional public frontend host: compiled assets and anonymous published-article HTML.
// It never runs Payload, accepts editorial writes or reads staff cookies.
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchPublishedArticle} from '../src/lib/published-articles.js';
import {renderArticleContent} from '../src/lib/article-content.js';
import {cmsFigure} from '../src/lib/cms-media.js';
import {publicOrigin} from '../src/lib/public-url.js';
import {normalizeBasePath,reportSlug,articleCanonical,articleSchema,safeJSON} from '../src/lib/public-routes.js';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2'};
const replaceMeta=(html,attribute,name,value)=>html.replace(new RegExp(`(<meta ${attribute}="${name}" content=")[^"]*(">)`),(_all,a,b)=>a+escape(value)+b);
export function createPublicServer({dist=process.env.PUBLIC_DIST || resolve(fileURLToPath(new URL('../dist/',import.meta.url))),cmsUrl=process.env.PUBLIC_CMS_URL,siteUrl=process.env.PUBLIC_SITE_URL,basePath=process.env.PUBLIC_BASE_PATH || '/',indexable=process.env.PUBLIC_INDEXABLE==='true',fetchImpl=fetch}={}) {
  basePath=normalizeBasePath(basePath);
  if(cmsUrl && !publicOrigin(cmsUrl))throw new Error('PUBLIC_CMS_URL must be HTTPS or loopback HTTP without credentials');
  async function htmlPage(article,message) {
    let html=await readFile(resolve(dist,'index.html'),'utf8');
    html=html.replace('<head>',`<head><base href="${escape(basePath)}">`);
    const canonical=article ? articleCanonical(article.slug,{siteUrl,basePath}) : '';
    const robots=indexable && canonical ? 'index,follow' : 'noindex,nofollow';
    let metadata=`<meta name="robots" content="${robots}">`;
    let body=`<main id="main"><h1>${escape(message || 'Church Times Nigeria')}</h1><a href="${escape(basePath)}#latest">Browse published reports</a></main>`;
    if(article) {
      html=html.replace(/<title>[^<]*<\/title>/,()=>`<title>${escape(article.title)} — Church Times Nigeria</title>`);
      html=replaceMeta(html,'name','description',article.excerpt);
      html=replaceMeta(html,'property','og:title',article.title);
      html=replaceMeta(html,'property','og:description',article.excerpt);
      html=replaceMeta(html,'property','og:type','article');
      if(canonical)metadata+=`<link rel="canonical" href="${escape(canonical)}"><meta property="og:url" content="${escape(canonical)}">`;
      metadata+=`<script id="article-schema" type="application/ld+json">${safeJSON(articleSchema(article,canonical))}</script>`;
      body=`<main id="main" class="container section-list newsroom-report"><a href="${escape(basePath)}#latest">Latest published reports</a><article><header class="article-header"><p>${escape(article.category)}</p><h1>${escape(article.title)}</h1><p class="article-deck">${escape(article.excerpt)}</p>${article.bylineName?`<p>By ${escape(article.bylineName)}</p>`:''}${article.publishedAt?`<time datetime="${escape(article.publishedAt)}">${escape(article.publishedAt.slice(0,10))}</time>`:''}</header>${cmsFigure(article.featuredImage,{eager:true,fallbackAlt:article.title})}<div class="article-body newsroom-article-body">${renderArticleContent(article.content,{baseUrl:cmsUrl})}</div>${article.corrections.length?`<section class="article-corrections"><h2>Corrections & updates</h2>${article.corrections.map(c=>`<p>${escape(c.note)}</p>`).join('')}</section>`:''}${article.legacyUrl?`<p><a href="${escape(article.legacyUrl)}" rel="noopener noreferrer">Original publication</a></p>`:''}</article></main>`;
    }
    return {html:html.replace('</head>',()=>metadata+'</head>').replace('<div id="app"></div>',()=>`<div id="app">${body}</div>`),robots};
  }
  return createServer(async(req,res)=>{
    const respond=(status,type,body,headers={})=>{res.writeHead(status,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store',...headers});res.end(req.method==='HEAD'?undefined:body);};
    if(!['GET','HEAD'].includes(req.method))return respond(405,'text/plain','Method not allowed',{Allow:'GET, HEAD'});
    try {
      const url=new URL(req.url,'http://public.invalid');
      if(!url.pathname.startsWith(basePath))return respond(404,'text/plain','Not found');
      const slug=reportSlug(url.pathname,basePath);
      if(url.pathname.startsWith(basePath+'reports/')) {
        if(!slug) {const page=await htmlPage(null,'Article unavailable.');return respond(404,mime['.html'],page.html,{'X-Robots-Tag':'noindex,nofollow'});}
        if(!url.pathname.endsWith('/'))return respond(308,'text/plain','Canonical article path',{Location:basePath+'reports/'+slug+'/'});
        let article;
        try {article=cmsUrl ? await fetchPublishedArticle({baseUrl:cmsUrl,slug,fetchImpl,timeoutMs:6000}) : undefined;}
        catch {const page=await htmlPage(null,'The newsroom is temporarily unavailable.');return respond(503,mime['.html'],page.html,{'X-Robots-Tag':'noindex,nofollow','Retry-After':'60'});}
        const page=await htmlPage(article,article===null?'Article unavailable.':'The newsroom connection is not configured.');
        return respond(article?200:article===null?404:503,mime['.html'],page.html,{'X-Robots-Tag':page.robots});
      }
      const relative=decodeURIComponent(url.pathname.slice(basePath.length));
      if(relative==='' || relative==='index.html') {const page=await htmlPage(null);return respond(200,mime['.html'],page.html,{'X-Robots-Tag':'noindex,nofollow'});}
      if(relative.includes('\\') || relative.includes('\0'))return respond(400,'text/plain','Invalid path');
      // The prepared Pages build keeps assets in dist/site; an unprepared
      // dist keeps them at its root. Preserve the /site/ URL in either layout.
      const assetPath=relative.startsWith('site/')?relative.slice(5):relative;
      const siteRoot=resolve(dist,'site');
      const prepared=(await stat(siteRoot).catch(()=>null))?.isDirectory();
      const file=resolve(relative.startsWith('site/')&&prepared?siteRoot:dist,assetPath);
      const staticRoot=relative.startsWith('site/')&&prepared?siteRoot:resolve(dist);
      if(!file.startsWith(staticRoot+sep))return respond(404,'text/plain','Not found');
      if(!(await stat(file)).isFile())return respond(404,'text/plain','Not found');
      return respond(200,mime[extname(file)] || 'application/octet-stream',await readFile(file),{'Cache-Control':/\/assets\//.test(file)?'public, max-age=31536000, immutable':'no-cache'});
    } catch {return respond(404,'text/plain','Not found');}
  });
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT || 5373);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
  const server=createPublicServer();server.listen(port,process.env.HOST || '127.0.0.1',()=>console.log(`Public frontend ready on port ${port}`));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
