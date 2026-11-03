// CMS-driven homepage and section feeds. This module is loaded only when a CMS is configured.
import './cms-home.css';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={analysis:'Analysis',opinion:'Opinion',sponsored:'Sponsored',explainer:'Explainer',factcheck:'Fact-check'};
const active = ctx => ctx.target.isConnected && !ctx.signal.aborted;
const meta = a => [labels[a.contentType],a.category || 'Newsroom'].filter(Boolean).map(esc).join(' · ');
const date = a => a.publishedAt ? `<time datetime="${esc(a.publishedAt)}">${esc(new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'Africa/Lagos'}).format(new Date(a.publishedAt)))}</time>` : '';

export function categoryIdsFor(categories, names) {
  const wanted=new Set(names.map(name=>name.trim().toLowerCase()));
  return categories.filter(c=>wanted.has(c.title.toLowerCase()) || wanted.has(c.slug.toLowerCase())).map(c=>c.id);
}
export function uniqueVisible(articles, seen, href) {
  return articles.filter(article=>{if(!href(article)||seen.has(article.slug))return false;seen.add(article.slug);return true;});
}
function leadArticle(article,ctx) {
  const href=esc(ctx.href(article)),image=article.featuredImage?ctx.image(article.featuredImage,{eager:true,fallbackAlt:article.title}):'';
  return `<article class="lead-story" data-story-slug="${esc(article.slug)}"><a class="lead-photo" href="${href}" tabindex="-1" aria-hidden="true">${image}</a><div class="lead-content"><span class="eyebrow light-eyebrow">${meta(article)}</span><h1><a href="${href}">${esc(article.title)}</a></h1><p>${esc(article.excerpt)}</p><div class="lead-bottom"><span>${article.bylineName?'By '+esc(article.bylineName)+' · ':''}${date(article)}</span><a href="${href}" class="circle-link" aria-label="Read the lead story">${ctx.icon('arrow',21)}</a></div></div>${ctx.markCMS(article,'lead-save')}</article>`;
}
function railArticle(article,ctx) {
  const href=esc(ctx.href(article)),image=article.featuredImage?ctx.image(article.featuredImage,{card:true,fallbackAlt:article.title}):'';
  return `<article class="rail-story" data-story-slug="${esc(article.slug)}"><div><span class="eyebrow clay">${meta(article)}</span><h2><a href="${href}">${esc(article.title)}</a></h2>${date(article)}</div>${image?`<a href="${href}" tabindex="-1" aria-hidden="true">${image}</a>`:''}</article>`;
}
function empty(title,description) {return `<div class="newsroom-state"><h2>${esc(title)}</h2><p role="status">${esc(description)}</p></div>`;}

// One request per page, with category IDs resolved from the CMS. A changed filter
// invalidates any in-flight response; the route signal cancels on navigation.
function makeFeed(ctx,{grid,more,announcement,pinned=[],names=[]}) {
  const seen=new Set(pinned), categoryCache={promise:null};
  let generation=0,nextPage=null,currentNames=names;
  const categories=()=>categoryCache.promise ||= ctx.categories({baseUrl:ctx.cmsUrl,signal:ctx.signal}).catch(error=>{categoryCache.promise=null;throw error;});
  async function load(page=1,{reset=false,names:nextNames=currentNames,first=null}={}) {
    const run=++generation;currentNames=nextNames;
    if(reset){seen.clear();pinned.forEach(slug=>seen.add(slug));grid.innerHTML='';}
    more.innerHTML='<p role="status">Loading published reports…</p>';
    try {
      let result=first;
      if(!result) {
        const ids=nextNames.length?categoryIdsFor((await categories()).articles,nextNames):undefined;
        if(run!==generation||!active(ctx))return;
        result=ids && !ids.length ? {articles:[],nextPage:null} : await ctx.fetchPage({baseUrl:ctx.cmsUrl,signal:ctx.signal,page,limit:12,...(ids?{categoryIds:ids}:{})});
      }
      if(run!==generation||!active(ctx))return;
      const fresh=uniqueVisible(result.articles,seen,ctx.href);
      grid.insertAdjacentHTML('beforeend',fresh.map(ctx.card).join(''));
      ctx.bindImages(grid);
      if(!grid.children.length)grid.innerHTML=empty('No published stories in this selection.','Try another section.');
      else grid.querySelector('.newsroom-state')?.remove();
      document.dispatchEvent(new Event('ct:home-stories-changed'));
      nextPage=result.nextPage;
      announcement.textContent=`${fresh.length} ${fresh.length===1?'story':'stories'} loaded.`;
      more.innerHTML=nextPage?'<button class="outline-button" type="button">More stories</button>':'<p class="muted small" role="status">You’re up to date with this selection.</p>';
      more.querySelector('button')?.addEventListener('click',()=>{const old=grid.querySelectorAll('article').length;load(nextPage).then(()=>grid.querySelectorAll('article h2 a,article h3 a')[old]?.focus({preventScroll:true}));});
    } catch(error) {
      if(run!==generation||!active(ctx))return;
      if(!grid.querySelector('article') && ctx.fallbackOnFirstFailure){ctx.fallback();return;}
      more.innerHTML='<p role="status">Stories could not be loaded. Please try again.</p><button type="button" class="outline-button">Try again</button>';
      more.querySelector('button').addEventListener('click',()=>load(page,{names:nextNames}));
    }
  }
  return {load};
}

export async function mountHome(ctx) {
  try {
    let first=await ctx.fetchPage({baseUrl:ctx.cmsUrl,signal:ctx.signal,limit:12,page:1});
    if(!active(ctx))return;
    const seen=new Set();let articles=uniqueVisible(first.articles,seen,ctx.href);
    // A page containing only invalid or reserved slugs must not hide later pages.
    for(let attempts=0;!articles.length && first.nextPage && attempts<4;attempts++) {
      first=await ctx.fetchPage({baseUrl:ctx.cmsUrl,signal:ctx.signal,limit:12,page:first.nextPage});
      if(!active(ctx))return;
      articles=uniqueVisible(first.articles,seen,ctx.href);
    }
    if(!articles.length){ctx.target.innerHTML='<section class="container section-list"><h1>Newsroom stories are on the way.</h1><p role="status">No published stories are available yet.</p></section>';return;}
    const lead=articles[0],rail=articles.slice(1,4),pinned=[lead,...rail].map(a=>a.slug);
    ctx.target.innerHTML=`<div class="container"><div class="edition-line"><span><span class="status-dot"></span> THE LATEST EDITION</span><span>Faith, public life & everything in between</span></div><section class="lead-layout" aria-label="Featured stories">${leadArticle(lead,ctx)}<aside class="latest-rail"><div class="rail-heading"><span class="eyebrow">IN THE HEADLINES</span><span class="rail-rule"></span></div>${rail.map(a=>railArticle(a,ctx)).join('')}<a href="#latest" class="text-link rail-link">More from the newsroom ${ctx.icon('arrow',18)}</a></aside></section><template data-ad-placement="homepage-billboard"></template><section class="news-section homepage-latest" id="latest">${ctx.heading('THE NEWSROOM','Latest news.','<a class="text-link" href="#latest">All news '+ctx.icon('arrow',17)+'</a>')}<div class="story-filters" aria-label="Filter latest stories">${['All','News','Business','Features','Opinion','Interviews'].map(name=>`<button type="button" data-cms-filter="${name}" aria-pressed="${name==='All'}" class="${name==='All'?'selected':''}">${name}</button>`).join('')}</div><p class="sr-only" aria-live="polite" data-cms-announcement></p><div class="story-grid" id="latest-grid"></div><div class="load-more-wrap" id="load-more-wrap"></div></section><template data-ad-placement="mobile-banner"></template><div id="home-editorial"></div></div>`;
    ctx.bindImages(ctx.target);ctx.mountAds(ctx.target);
    const feed=makeFeed(ctx,{grid:ctx.target.querySelector('#latest-grid'),more:ctx.target.querySelector('#load-more-wrap'),announcement:ctx.target.querySelector('[data-cms-announcement]'),pinned});
    ctx.target.querySelectorAll('[data-cms-filter]').forEach(button=>button.addEventListener('click',()=>{
      ctx.target.querySelectorAll('[data-cms-filter]').forEach(item=>{const on=item===button;item.classList.toggle('selected',on);item.setAttribute('aria-pressed',String(on));});
      const section=ctx.sections.find(item=>item.name.toLowerCase()===button.dataset.cmsFilter.toLowerCase());
      const names=button.dataset.cmsFilter==='All'?[]:(section?.categories || [button.dataset.cmsFilter]);
      void feed.load(1,{reset:true,names});
    }));
    await feed.load(1,{first:{...first,articles:articles.slice(4)}});
  } catch {if(active(ctx))ctx.fallback();}
}

export async function mountSection(ctx) {
  const feed=makeFeed({...ctx,fallbackOnFirstFailure:true},{grid:ctx.target.querySelector('[data-cms-grid]'),more:ctx.target.querySelector('[data-cms-more]'),announcement:ctx.target.querySelector('[data-cms-announcement]'),names:ctx.section.categories});
  await feed.load();
}
