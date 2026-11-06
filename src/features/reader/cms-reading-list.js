export function toggleSaved({button,saved,persistSaved,toast,refresh}) {
  if(!button.isConnected)return;
  const slug=button.dataset.cmsSave,key='cms:'+slug;
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)||slug.length>160)return;
  if(saved.has(key)){saved.delete(key);toast('Removed from your reading list.');}else{saved.add(key);toast('Saved to your reading list.');}
  persistSaved();
  document.querySelectorAll('[data-cms-save]').forEach(item=>{if(item.dataset.cmsSave!==slug)return;const active=saved.has(key);item.classList.toggle('is-saved',active);item.setAttribute('aria-pressed',String(active));item.setAttribute('aria-label',`${active?'Remove from':'Save to'} reading list: ${item.dataset.title}`);});
  const count=document.querySelector('#saved-count');count.textContent=saved.size;count.hidden=!saved.size;document.querySelector('.reading-link').setAttribute('aria-label',`Reading list, ${saved.size} saved stories`);
  if(location.hash==='#saved')refresh();
}

export function renderSaved(ctx) {
  const {target,signal,stories,saved,card,reportCard,markCMS,icon,escape,reportPath,publicBase,cmsUrl,fetchArticle,bindImages,bindSaves,persistSaved,refresh,toast}=ctx;
  if(!target.isConnected||signal.aborted)return;
  const list=stories.filter(s=>saved.has(s.id)),slugs=[...saved].filter(id=>typeof id==='string'&&id.startsWith('cms:')).map(id=>id.slice(4));
  target.innerHTML=`<div class="listing-meta"><span>${saved.size} saved ${saved.size===1?'story':'stories'}</span>${saved.size?'<button class="text-button" id="clear-saved">Clear reading list</button>':''}</div><div class="story-grid" id="saved-grid">${list.map(s=>card(s)).join('')}${slugs.map(slug=>`<article class="story-card" data-saved-slug="${escape(slug)}"><h2><a href="${escape(reportPath(slug,publicBase)||'#latest')}">${escape(slug.replaceAll('-',' '))}</a></h2><p>Loading saved story…</p>${markCMS({slug,title:slug.replaceAll('-',' ')})}</article>`).join('')}${saved.size?'':'<div class="empty-state"><span class="empty-icon">'+icon('bookmark',38)+'</span><h2>A little room for good reading.</h2><p>Use the bookmark beside a story to save it for later.</p><a class="button button-dark" href="#home">Find a story '+icon('arrow',17)+'</a></div>'}</div>`;
  bindSaves();
  target.querySelector('#clear-saved')?.addEventListener('click',()=>{saved.clear();persistSaved();refresh();toast('Reading list cleared.');});
  if(slugs.length)void loadSaved({grid:target.querySelector('#saved-grid'),slugs,signal,cmsUrl,fetchArticle,card:reportCard,bindImages});
}

// Load only published records; the browser stores slugs, never article bodies.
export async function loadSaved({grid,slugs,signal,cmsUrl,fetchArticle,card,bindImages}) {
  let next=0;
  async function worker(){
    while(next<slugs.length && grid.isConnected && !signal.aborted){
      const slug=slugs[next++],slot=grid.querySelector(`[data-saved-slug="${slug}"]`);
      try {
        const article=cmsUrl && await fetchArticle({baseUrl:cmsUrl,slug,signal});
        if(!slot?.isConnected || signal.aborted)continue;
        if(article){slot.outerHTML=card(article);bindImages(grid);}
        else slot.querySelector('p').textContent='This story is no longer available in the published edition.';
      } catch {
        if(slot?.isConnected && !signal.aborted)slot.querySelector('p').textContent='Story details are unavailable. Try again when the newsroom is online.';
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(4,slugs.length)},worker));
}

export async function loadRelated({target,article,signal,cmsUrl,fetchPage,href,card,bindImages}) {
  try {
    const {articles}=await fetchPage({baseUrl:cmsUrl,signal,limit:8,...(article.categoryId?{categoryId:article.categoryId}:{})});
    if(!target.isConnected || signal.aborted)return;
    const seen=new Set([article.slug]);
    const related=articles.filter(item=>{if(!href(item)||seen.has(item.slug))return false;seen.add(item.slug);return true;}).slice(0,3);
    if(!related.length)return;
    target.innerHTML=`<section class="related-section" aria-labelledby="related-reports-title"><div class="section-heading"><div><span class="eyebrow">KEEP EXPLORING</span><h2 id="related-reports-title">${article.categoryId?'Related stories':'More from the newsroom'}</h2></div></div><div class="story-grid">${related.map(card).join('')}</div></section>`;
    bindImages(target);
  } catch { /* The article remains readable if recommendations are unavailable. */ }
}
