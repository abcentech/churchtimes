// Author profile and trust pages (/author/{slug}/, /about/editorial-standards/, /about/ownership/, /corrections/).
// Shared by the public host (server render, no JavaScript needed to read) and the lazy client view. Data comes only from
// the anonymous read-only endpoints in apps/cms/docs/w12/schema-contract.md section 3; every string is escaped here.
import {publicOrigin} from './public-url.js';
import {CMSReadError,normalizePublishedArticle,mediaUrl} from './published-articles.js';
import {renderArticleContent} from './article-content.js';
import {cmsImage} from './cms-media.js';
import {cardLabel,formatDate,authorPath} from './reader-article.js';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
const validSlug=value=>typeof value==='string' && value.length<=160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
export const TRUST_PAGES={
  'editorial-standards':{field:'editorialStandards',path:'about/editorial-standards/',title:'Editorial standards',description:'How Church Times Nigeria reports, verifies, labels and edits its journalism.'},
  ownership:{field:'ownershipFunding',path:'about/ownership/',title:'Ownership and funding',description:'Who owns Church Times Nigeria and how its journalism is funded.'},
  corrections:{field:'ethicsCorrectionsPolicy',path:'corrections/',title:'Corrections',description:'How Church Times Nigeria corrects its journalism, and every published correction.'},
};
export const pageNumber=value=>{const page=Number(value);return Number.isInteger(page)&&page>=1&&page<=50?page:1;};
// Route keys returned by publicPageRoute(): ['author', slug], ['trust', 'editorial-standards'|'ownership'], ['corrections'].
export const readerPageKey=(kind,param)=>kind==='corrections'?'corrections':kind==='trust'&&TRUST_PAGES[param]&&param!=='corrections'?param:kind==='author'&&validSlug(param)?'author':'';

export async function fetchPublicJSON(cmsUrl,path,{fetchImpl=fetch,signal,timeoutMs=6000}={}) {
  const origin=publicOrigin(cmsUrl);
  if(!origin)throw new CMSReadError('configuration','CMS base URL must be an absolute HTTP(S) URL');
  const controller=new AbortController(),abort=()=>controller.abort();
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  try {
    const response=await fetchImpl(origin+path,{method:'GET',headers:{Accept:'application/json'},credentials:'omit',redirect:'error',signal:controller.signal});
    if(response.status===404)return null;
    if(!response.ok)throw new CMSReadError('http',`CMS request failed (${response.status})`,response.status,Number(response.headers?.get?.('retry-after'))||0);
    try {return await response.json();} catch {throw new CMSReadError('response','Unexpected CMS response');}
  } catch(error) {
    if(error instanceof CMSReadError)throw error;
    if(signal?.aborted)throw new CMSReadError('cancelled','CMS request aborted on navigation');
    if(timedOut)throw new CMSReadError('timeout','CMS request aborted after timeout');
    throw new CMSReadError('network','CMS network request failed');
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

// Listings only need card fields; never carry (or embed in the page) an article body.
const listed=article=>article&&{...article,content:null,corrections:[]};
const SOCIAL_LABELS={x:'X',facebook:'Facebook',instagram:'Instagram',linkedin:'LinkedIn',website:'Website'};
const safeHttp=value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}};
export function normalizeAuthorPage(payload,{baseUrl}={}) {
  const author=payload?.author;
  if(!author || author.isPublic!==true || !validSlug(author.slug) || !text(author.name,120))return null;
  const avatar=author.avatar && typeof author.avatar==='object'?mediaUrl(author.avatar.thumbnailUrl,baseUrl)||mediaUrl(author.avatar.url,baseUrl):'';
  return {
    name:text(author.name,120),slug:author.slug,role:text(author.role,120),bio:text(author.bio,600),avatar,
    socials:(Array.isArray(author.socials)?author.socials:[]).slice(0,6).map(s=>({kind:SOCIAL_LABELS[s?.kind]?s.kind:'website',url:safeHttp(s?.url)})).filter(s=>s.url),
    articles:(Array.isArray(payload.articles)?payload.articles:[]).slice(0,20).map(card=>listed(normalizePublishedArticle(card,{baseUrl}))).filter(Boolean),
    page:pageNumber(payload.page),hasNextPage:payload.hasNextPage===true,
  };
}
const isLexical=value=>Boolean(value && typeof value==='object' && value.root && typeof value.root==='object');
export function normalizeSiteTrust(payload) {
  if(!payload || typeof payload!=='object')return null;
  return {editorialStandards:isLexical(payload.editorialStandards)?payload.editorialStandards:null,ownershipFunding:isLexical(payload.ownershipFunding)?payload.ownershipFunding:null,ethicsCorrectionsPolicy:isLexical(payload.ethicsCorrectionsPolicy)?payload.ethicsCorrectionsPolicy:null,contactEditors:text(payload.contactEditors,1000)};
}
export function normalizeCorrectionsLog(payload,{baseUrl}={}) {
  const docs=(Array.isArray(payload?.docs)?payload.docs:[]).slice(0,50).map(doc=>{
    const article=listed(normalizePublishedArticle(doc?.article,{baseUrl}));
    const corrections=(Array.isArray(doc?.corrections)?doc.corrections:[]).slice(0,50).map(c=>({note:text(c?.note,2000),correctedAt:typeof c?.correctedAt==='string'&&Number.isFinite(Date.parse(c.correctedAt))?new Date(c.correctedAt).toISOString():''})).filter(c=>c.note);
    return article&&corrections.length?{article,corrections}:null;
  }).filter(Boolean);
  return {docs,page:pageNumber(payload?.page),hasNextPage:payload?.hasNextPage===true};
}

// Loads everything a page needs. Returns {status, data}; status 404 when the page has nothing published to show.
export async function loadReaderPage(key,{cmsUrl,slug,page=1,fetchImpl,signal,timeoutMs}={}) {
  const options={fetchImpl,signal,timeoutMs};
  if(key==='author') {
    const author=normalizeAuthorPage(await fetchPublicJSON(cmsUrl,`/api/public/authors/${encodeURIComponent(slug)}?page=${page}`,options),{baseUrl:cmsUrl});
    return author?{status:200,data:{author}}:{status:404,data:null};
  }
  const [trustPayload,log]=await Promise.all([fetchPublicJSON(cmsUrl,'/api/public/site-trust',options),key==='corrections'?fetchPublicJSON(cmsUrl,`/api/public/corrections?page=${page}`,options):null]);
  const trust=normalizeSiteTrust(trustPayload);
  if(key==='corrections')return {status:200,data:{trust,log:normalizeCorrectionsLog(log||{},{baseUrl:cmsUrl})}};
  return trust?.[TRUST_PAGES[key].field]?{status:200,data:{trust}}:{status:404,data:null};
}

const paragraphs=value=>value.split(/\n{2,}/).map(p=>p.trim()).filter(Boolean).map(p=>`<p>${escape(p).replace(/\n/g,'<br>')}</p>`).join('');
function articleCard(article,href) {
  const label=cardLabel(article);
  return `<article class="story-card newsroom-card">${article.featuredImage?`<a class="newsroom-card-image" href="${escape(href)}" tabindex="-1" aria-hidden="true">${cmsImage(article.featuredImage,{card:true,fallbackAlt:article.title})}</a>`:''}<div class="newsroom-card-meta"><span class="eyebrow clay">${label?escape(label)+' · ':''}${escape(article.category||'Newsroom')}</span>${article.publishedAt?`<time datetime="${escape(article.publishedAt)}">${escape(formatDate(article.publishedAt))}</time>`:''}</div><h3><a href="${escape(href)}">${escape(article.title)}</a></h3><p>${escape(article.excerpt)}</p></article>`;
}
const pager=(page,hasNextPage,label,path)=>page>1||hasNextPage?`<nav class="reader-pager" aria-label="${escape(label)}">${page>1?`<a class="outline-button" href="${escape(page>2?path+'?page='+(page-1):path)}" rel="prev">Newer</a>`:'<span></span>'}${hasNextPage?`<a class="outline-button" href="${escape(path+'?page='+(page+1))}" rel="next">Older</a>`:''}</nav>`:'';
function trustLinks(trust,current,base) {
  const links=Object.entries(TRUST_PAGES).filter(([key,page])=>key!==current&&(key==='corrections'||trust?.[page.field])).map(([,page])=>`<a href="${escape(base+page.path)}">${escape(page.title)}</a>`);
  return links.length?`<nav class="reader-trust-links" aria-label="Our standards">${links.join('')}</nav>`:'';
}
const contactBlock=trust=>trust?.contactEditors?`<section class="reader-contact" aria-labelledby="reader-contact-title"><h2 id="reader-contact-title">Contact the editors</h2>${paragraphs(trust.contactEditors)}</section>`:'';

// Returns {title, description, html, schema}. `canonical(path)` turns a site path into an absolute URL or ''.
export function renderReaderPage(key,data,{base='/',baseUrl,articleHref,canonical=()=>''}={}) {
  const home=canonical(base),crumbs=list=>({'@type':'BreadcrumbList',itemListElement:list.filter(item=>item.item).map((item,index)=>({'@type':'ListItem',position:index+1,name:item.name,item:item.item}))});
  if(key==='author') {
    const {author}=data,url=canonical(authorPath(author.slug,base));
    const title=author.name,description=author.role?`${author.name}, ${author.role} at Church Times Nigeria.`:`Reporting by ${author.name} for Church Times Nigeria.`;
    const html=`<header class="reader-profile">${author.avatar?`<img class="reader-avatar" src="${escape(author.avatar)}" width="128" height="128" alt="" loading="eager" decoding="async">`:''}<div><span class="eyebrow clay">AUTHOR</span><h1>${escape(author.name)}</h1>${author.role?`<p class="reader-role">${escape(author.role)}</p>`:''}${author.bio?`<div class="reader-bio">${paragraphs(author.bio)}</div>`:''}${author.socials.length?`<ul class="reader-socials" aria-label="${escape(author.name)} elsewhere">${author.socials.map(s=>`<li><a href="${escape(s.url)}" rel="me noopener noreferrer">${escape(SOCIAL_LABELS[s.kind])}</a></li>`).join('')}</ul>`:''}</div></header><h2 class="reader-section-title">Latest from ${escape(author.name)}</h2>${author.articles.length?`<div class="story-grid">${author.articles.map(a=>articleCard(a,articleHref(a.slug))).join('')}</div>`:'<p>No published stories yet.</p>'}${pager(author.page,author.hasNextPage,'More stories by this author',authorPath(author.slug,base))}`;
    const person={'@type':'Person',name:author.name,...(author.role?{jobTitle:author.role}:{}),...(author.bio?{description:author.bio}:{}),...(author.avatar?{image:author.avatar}:{}),...(url?{url}:{}),...(author.socials.length?{sameAs:author.socials.map(s=>s.url)}:{}),worksFor:{'@type':'NewsMediaOrganization',name:'Church Times Nigeria',...(home?{url:home}:{})}};
    return {title,description,html,schema:{'@context':'https://schema.org','@graph':[{'@type':'ProfilePage',...(url?{url}:{}),mainEntity:person},crumbs([{name:'Home',item:home},{name:author.name,item:url}])]}};
  }
  const page=TRUST_PAGES[key],{trust}=data,url=canonical(base+page.path);
  const policy=trust?.[page.field]?renderArticleContent(trust[page.field],{baseUrl}):'';
  let body=policy?`<div class="newsroom-article-body reader-prose">${policy}</div>`:'';
  if(key==='corrections') {
    const {log}=data;
    body+=`<h2 class="reader-section-title" id="corrections-log">Corrections log</h2>${log.docs.length?`<ol class="reader-log" aria-labelledby="corrections-log">${log.docs.map(({article,corrections})=>`<li><h3><a href="${escape(articleHref(article.slug))}">${escape(article.title)}</a></h3><ul>${corrections.map(c=>`<li>${c.correctedAt?`<time datetime="${escape(c.correctedAt)}">${escape(formatDate(c.correctedAt))}</time>`:''}${escape(c.note)}</li>`).join('')}</ul></li>`).join('')}</ol>`:'<p>No corrections have been published.</p>'}${pager(log.page,log.hasNextPage,'More corrections',base+page.path)}`;
  }
  const html=`<header class="reader-page-head"><span class="eyebrow clay">OUR STANDARDS</span><h1>${escape(page.title)}</h1><p>${escape(page.description)}</p>${trustLinks(trust,key,base)}</header>${body}${contactBlock(trust)}`;
  const organization={'@type':'NewsMediaOrganization',name:'Church Times Nigeria',...(home?{url:home}:{}),...Object.fromEntries([['publishingPrinciples','editorial-standards'],['ownershipFundingInfo','ownership'],['correctionsPolicy','corrections']].filter(([,k])=>k==='corrections'||trust?.[TRUST_PAGES[k].field]).map(([prop,k])=>[prop,canonical(base+TRUST_PAGES[k].path)]).filter(([,v])=>v))};
  return {title:page.title,description:page.description,html,schema:{'@context':'https://schema.org','@graph':[{'@type':'WebPage',name:page.title,...(url?{url}:{}),about:organization},crumbs([{name:'Home',item:home},{name:page.title,item:url}])]}};
}
