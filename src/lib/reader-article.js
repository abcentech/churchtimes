// Article trust and reading furniture shared by the public host (server render) and the lazy client renderer:
// content-type label, kicker, byline link, Updated stamp, reading time and the key-points block.
// Input is always a normalizePublishedArticle() result; every string is escaped here.
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const CONTENT_TYPE_LABELS={news:'News',analysis:'Analysis',opinion:'Opinion',sponsored:'Sponsored',explainer:'Explainer',factcheck:'Fact-check'};
export const contentTypeLabel=type=>CONTENT_TYPE_LABELS[type]||CONTENT_TYPE_LABELS.news;
const DISCLOSURES={
  opinion:'Opinion: the views expressed are the writer’s own.',
  sponsored:'Sponsored content: paid for by a commercial partner.',
};
const longDate=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'Africa/Lagos'});
export const formatDate=iso=>longDate.format(new Date(iso));
const timeTag=iso=>`<time datetime="${escape(iso)}">${escape(formatDate(iso))}</time>`;

// Words in the readable body: Lexical text nodes or a plain-text body. Pull quotes repeat the body and gallery
// captions are not read straight through, so neither counts. Matches readingMinutes() in apps/cms/src/lib/newsroomFields.ts.
export function countWords(content) {
  if(typeof content==='string')return content.split(/\s+/).filter(Boolean).length;
  let words=0,budget=20000;
  const walk=node=>{
    if(!node || typeof node!=='object' || --budget<0 || node.type==='block')return;
    if(node.type==='text' && typeof node.text==='string')words+=node.text.split(/\s+/).filter(Boolean).length;
    if(Array.isArray(node.children))for(const child of node.children)walk(child);
  };
  walk(content?.root);
  return words;
}
export const readingMinutes=content=>Math.max(1,Math.round(countWords(content)/220));

export const authorPath=(slug,base='/')=>`${base}author/${slug}/`;
// The Updated stamp is editor-set (never automatic) and only shown when it is later than publication.
export const showUpdated=article=>Boolean(article.lastSubstantiveUpdate && (!article.publishedAt || Date.parse(article.lastSubstantiveUpdate)>Date.parse(article.publishedAt)));

export function eyebrowHTML(article) {
  const type=article.contentType||'news';
  return `<span class="reader-type" data-type="${escape(type)}">${escape(contentTypeLabel(type))}</span>${article.category?`<span class="reader-eyebrow-sep" aria-hidden="true"> · </span>${escape(article.category)}`:''}`;
}
export const kickerHTML=article=>article.kicker?`<p class="reader-kicker">${escape(article.kicker)}</p>`:'';
export function disclosureHTML(article) {
  const text=DISCLOSURES[article.contentType];
  return text?`<p class="reader-disclosure" data-type="${escape(article.contentType)}">${escape(text)}</p>`:'';
}
export function bylineHTML(article,{base='/'}={}) {
  if(article.bylineProfile)return `<strong class="newsroom-byline">By <a href="${escape(authorPath(article.bylineProfile.slug,base))}" rel="author">${escape(article.bylineProfile.name)}</a></strong>`;
  return article.bylineName?`<strong class="newsroom-byline">By ${escape(article.bylineName)}</strong>`:'';
}
export function metaHTML(article,{base='/'}={}) {
  const parts=[];
  if(article.publishedAt)parts.push(`<span class="reader-published">${timeTag(article.publishedAt)}</span>`);
  if(showUpdated(article))parts.push(`<span class="reader-updated">Updated ${timeTag(article.lastSubstantiveUpdate)}</span>`);
  parts.push(`<span class="reader-time">${readingMinutes(article.content)} min read</span>`);
  return `${bylineHTML(article,{base})}<span class="reader-meta">${parts.join('<span aria-hidden="true"> · </span>')}</span>`;
}
export function keyPointsHTML(article) {
  const points=Array.isArray(article.keyPoints)?article.keyPoints.filter(Boolean):[];
  if(!points.length)return '';
  return `<section class="reader-keypoints" aria-labelledby="reader-keypoints-title"><h2 id="reader-keypoints-title">What you need to know</h2><ul>${points.map(point=>`<li>${escape(point)}</li>`).join('')}</ul></section>`;
}
// Card eyebrow prefix: every non-news type is named on cards so opinion and sponsored work is never mistaken for news.
export const cardLabel=article=>article.contentType && article.contentType!=='news'?contentTypeLabel(article.contentType):'';
// Server-rendered article header (tools/serve-public.mjs); the client template in src/main.js composes the same pieces.
export const articleHeaderHTML=(article,{base='/'}={})=>`<header class="article-header"><span class="eyebrow clay">${eyebrowHTML(article)}</span>${kickerHTML(article)}<h1>${escape(article.title)}</h1><p class="article-deck">${escape(article.excerpt)}</p>${disclosureHTML(article)}<div class="article-meta"><div>${metaHTML(article,{base})}</div></div></header>`;
