import { publicFormMarkup, bindPublicForm } from './forms/public-form.js';
import { fetchPublishedPage, fetchPublishedArticle } from './lib/published-articles.js';
import { renderArticleContent } from './lib/article-content.js';
import '@fontsource-variable/newsreader/wght.css';
import '@fontsource-variable/newsreader/wght-italic.css';
import '@fontsource-variable/dm-sans/wght.css';
import './style.css';
import edition from './data/stories.json';
import imageSizes from './data/image-sizes.json';

const stories = edition.stories;
const asset = path => `${import.meta.env.BASE_URL}${import.meta.env.PROD ? 'site/' : ''}${path}`;
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = (name, size=20) => {
  const paths = {
    arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>', diagonal:'<path d="M5 19 19 5M5 5h14v14"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    bookmark:'<path d="M6 4h12v17l-6-4-6 4Z"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>',
    menu:'<path d="M4 6h16M4 12h16M4 18h16"/>', clock:'<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    share:'<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m9 10 6-3M9 14l6 3"/>',
    mail:'<rect x="3" y="5" width="18" height="14" rx="1"/><path d="m3 6 9 7 9-7"/>',
    home:'<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>', down:'<path d="m6 9 6 6 6-6"/>', check:'<path d="m5 12 4 4L19 6"/>',
  };
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.arrow}</svg>`;
};
const sections = [
  {slug:'news',name:'News',categories:['News'],description:'The church, public life and the stories shaping our shared world.'},
  {slug:'features',name:'Features',categories:['Features'],description:'Closer looks at the people, ideas and institutions behind the headlines.'},
  {slug:'interviews',name:'Interviews',categories:['Interviews'],description:'Conversations about faith, leadership, service and experience.'},
  {slug:'business',name:'Business',categories:['Business'],description:'Enterprise, trade and the economic questions that affect everyday life.'},
  {slug:'health',name:'Health & education',categories:['Health','Education'],description:'Reporting and perspectives on care, learning and public accountability.'},
  {slug:'opinion',name:'Opinion',categories:['Opinion','Columnists'],description:'Attributed arguments, reflections and columns from our contributors.'},
  {slug:'publishers-note',name:'Publisher’s note',categories:["Publisher's Note"],description:'Gbenga Osinaike’s reflections on faith, public life and the questions before us.'},
];
const date = (s, long=false) => new Intl.DateTimeFormat('en-GB',{day:'numeric',month:long?'long':'short',year:'numeric',timeZone:'Africa/Lagos'}).format(new Date(s.dateGMT));
const editionDate = 'Monday, 5 October 2026';
const href = s => `#story/${s.slug}`;
const byId = id => stories.find(s => s.id === id);
const inSection = (s, section) => section.categories.some(c=>s.categories.includes(c));
let saved;
try { saved = new Set(JSON.parse(localStorage.getItem('ct-reading-list')||'[]').filter(id=>stories.some(s=>s.id===id))); } catch { saved = new Set(); }
let filter = 'All';
let limit = 6;
let toastTimer;
let routeController = new AbortController();

function mark(s, className='') {
  return `<button class="save-button ${className} ${saved.has(s.id)?'is-saved':''}" data-save="${s.id}" aria-pressed="${saved.has(s.id)}" aria-label="${saved.has(s.id)?'Remove from':'Save to'} reading list: ${escape(s.title)}">${icon('bookmark',18)}</button>`;
}
function picture(s, className='', eager=false, sizes='(max-width: 430px) calc(100vw - 38px), (max-width: 760px) 45vw, 420px') {
  if (!s.image) return '<div class="photo-fallback">Church Times Nigeria</div>';
  const image = imageSizes[s.id];
  const responsive = image ? `width="${image.width}" height="${image.height}" srcset="${image.variants.map(width => `${asset(`news-media/responsive/${s.id}-${width}.webp`)} ${width}w`).join(', ')}" sizes="${sizes}"` : '';
  return `<img class="${className}" src="${asset(s.image)}" ${responsive} alt="${escape(s.imageAlt || '')}" loading="${eager?'eager':'lazy'}" ${eager?'fetchpriority="high"':''} decoding="async">`;
}
function wordmark(className='') { return `<a class="wordmark ${className}" href="#home" aria-label="Church Times Nigeria home"><span>Church<span class="wordmark-times">Times</span><i>.</i></span><small>NIGERIA</small></a>`; }
let disposePublicForm;
function shell(content, route='home') {
  disposePublicForm?.();
  disposePublicForm=undefined;
  routeController.abort();
  routeController = new AbortController();
  const mastheadDate = route === 'latest' ? 'Published newsroom reports' : editionDate;
  document.querySelector('#app').innerHTML = `
    <div class="utility-bar"><div class="container utility-inner"><span>INDEPENDENT JOURNALISM. A CHRISTIAN PERSPECTIVE.</span><div><a href="#latest">Latest news</a><a href="#about">About us</a><a href="#advertise">Advertise</a><a href="#contact">Contact</a></div></div></div>
    <header class="container masthead"><div class="masthead-left"><span>${mastheadDate}</span><p>The church.<br>The people. The world.</p></div>${wordmark()}<div class="masthead-right"><a class="outline-button" href="#connect">Stay connected ${icon('arrow',16)}</a><span>Reporting with purpose since 2007</span></div></header>
    <div class="nav-shell"><div class="container nav-inner"><a class="home-link ${route==='home'?'active':''}" href="#home" aria-label="Home" ${route==='home'?'aria-current="page"':''}>${icon('home',17)}</a><nav class="desktop-nav" aria-label="Main sections"><a href="#latest" ${route==='latest'?'aria-current="page"':''}>Latest</a>${sections.map(s=>`<a href="#section/${s.slug}" ${route===s.slug?'aria-current="page"':''}>${s.name}</a>`).join('')}</nav><div class="nav-actions"><a class="reading-link" href="#saved" aria-label="Reading list, ${saved.size} saved stories">${icon('bookmark',18)}<span id="saved-count" ${saved.size?'':'hidden'}>${saved.size}</span></a><button class="icon-button" data-search aria-label="Search stories" aria-haspopup="dialog" aria-controls="search-dialog" aria-expanded="false">${icon('search',19)}</button><button class="icon-button mobile-menu-button" data-menu aria-label="Open sections menu" aria-haspopup="dialog" aria-controls="menu-dialog" aria-expanded="false">${icon('menu',21)}</button></div></div></div>
    <main id="main" tabindex="-1">${content}</main>
    <section class="connect-band" id="connect"><div class="container connect-inner"><svg class="connect-monogram" viewBox="0 0 460 350" aria-hidden="true" focusable="false"><text x="0" y="280" fill="currentColor" font-size="330">CT<tspan fill="#c39368">.</tspan></text></svg><div><span class="eyebrow">KEEP A WIDER PERSPECTIVE</span><h2>Good stories deserve<br><em>your attention.</em></h2><p>Read the latest from Church Times Nigeria.<br>For publication updates, get in touch with the newsroom.</p></div><div class="connect-action"><a class="button button-light" href="mailto:info@churchtimesnigeria.net?subject=Church%20Times%20publication%20updates">Request updates ${icon('mail',18)}</a><small>Opens an email request to the publication.<br>You are not automatically subscribed.</small></div></div></section>
    <footer class="site-footer"><div class="container"><div class="footer-main"><div>${wordmark('footer-wordmark')}<p>Professional reporting on the church and on<br>Christians across every sphere of life.</p></div><div><span class="eyebrow">EXPLORE</span>${sections.slice(0,4).map(s=>`<a href="#section/${s.slug}">${s.name}</a>`).join('')}</div><div><span class="eyebrow">PERSPECTIVES</span><a href="#section/health">Health & education</a><a href="#section/opinion">Opinion & columns</a><a href="#section/publishers-note">Publisher’s note</a><a href="#latest">Latest newsroom reports</a><a href="#saved">Your reading list</a></div><div><span class="eyebrow">THE PUBLICATION</span><a href="#about">Our story</a><a href="#advertise">Advertise with us</a><a href="#contact">Contact the newsroom</a><a href="#submit">Submit a story</a><a href="https://churchtimesnigeria.net/" target="_blank" rel="noopener noreferrer">Current website ${icon('diagonal',12)}</a></div></div><div class="footer-bottom"><span>© ${new Date().getFullYear()} Church Times Nigeria · Churchtimes Agency Ltd</span><span>${route==='latest'?'Published newsroom reports':'Selected coverage · updated 5 October 2026'}</span><button class="text-button" data-privacy>Privacy & reading list</button></div></div></footer>
    <dialog id="search-dialog" aria-labelledby="search-title"><div class="dialog-bar"><span class="eyebrow">CHURCH TIMES NIGERIA</span><button class="icon-button" data-close aria-label="Close search">${icon('close')}</button></div><h2 id="search-title">What’s on your mind?</h2><form id="search-form"><label class="sr-only" for="search-input">Search headlines, topics or authors</label><div class="search-input-wrap">${icon('search')}<input id="search-input" type="search" name="query" placeholder="Search stories, topics or writers…" maxlength="120" required autocomplete="off"><button class="button button-dark" type="submit">Search ${icon('arrow',16)}</button></div></form><p class="muted small">Explore ${stories.length} selected stories from the current publication.</p><div class="search-suggestions"><span class="eyebrow">START WITH A TOPIC</span>${['Faith','Business','Education','Gbenga Osinaike'].map(q=>`<button data-query="${q}">${q} ${icon('diagonal',14)}</button>`).join('')}</div></dialog>
    <dialog id="menu-dialog" aria-labelledby="menu-title"><div class="dialog-bar"><h2 id="menu-title">Explore Church Times.</h2><button class="icon-button" data-close aria-label="Close menu">${icon('close')}</button></div><nav class="mobile-sections" aria-label="Mobile sections"><a href="#latest">Latest newsroom reports ${icon('arrow')}</a><a href="#saved">Your reading list ${icon('bookmark')}</a>${sections.map(s=>`<a href="#section/${s.slug}">${s.name} ${icon('arrow')}</a>`).join('')}<a href="#about">Our story ${icon('arrow')}</a><a href="#contact">Contact ${icon('arrow')}</a><a href="#advertise">Advertise ${icon('arrow')}</a><a href="#submit">Submit a story ${icon('arrow')}</a></nav></dialog>
    <dialog id="privacy-dialog" aria-labelledby="privacy-title"><div class="dialog-bar"><span class="eyebrow">YOUR READING EXPERIENCE</span><button class="icon-button" data-close aria-label="Close privacy notice">${icon('close')}</button></div><h2 id="privacy-title">A considered approach<br>to your privacy.</h2><p>Your reading list is saved only in this browser. It is not connected to an account and is not sent to the publisher. Clear it from the reading-list page or your browser’s site storage.</p><p>Public forms send the details you enter to the newsroom only when you submit. They do not save drafts in browser storage. When online sending is enabled, Cloudflare Turnstile loads to help prevent spam and is subject to Cloudflare’s privacy terms. This website has no analytics trackers, payment collection or automatic newsletter signup. Email and telephone links open the services you choose to use. The original publication and external services have their own privacy terms.</p></dialog>
    <dialog id="share-dialog" aria-labelledby="share-title"><div class="dialog-bar"><h2 id="share-title">Share this story</h2><button class="icon-button" data-close aria-label="Close sharing">${icon('close')}</button></div><p>Copy this link to share the article.</p><label for="share-url">Article link</label><input id="share-url" type="url" readonly><button class="outline-button" id="select-share-url">Select link</button></dialog>
    <div id="toast" role="status" aria-live="polite" aria-atomic="true"></div>`;
  bindCommon();
}
function card(s, featured=false) {
  return `<article class="story-card ${featured?'wide-card':''}"><a class="card-image" href="${href(s)}" tabindex="-1" aria-hidden="true">${picture(s)}<span class="image-tag">${escape(s.category)}</span></a><div class="card-copy"><div class="story-meta"><time datetime="${s.dateGMT}">${date(s)}</time>${mark(s)}</div><h3><a href="${href(s)}">${escape(s.title)}</a></h3><p>${escape(s.summary)}</p><div class="card-byline"><span>By ${escape(s.author)}</span><a href="${href(s)}" aria-label="Read briefing: ${escape(s.title)}">${icon('arrow',18)}</a></div></div></article>`;
}
function heading(eyebrow,title,link='') {
  return `<div class="section-heading"><div><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div>${link}</div>`;
}
function home() {
  const lead=byId(29259), latest=[byId(29276),byId(29267),byId(29264)];
  shell(`<div class="container"><div class="edition-line"><span><span class="status-dot"></span> THE LATEST EDITION</span><span>Faith, public life & everything in between</span></div><section class="lead-layout" aria-label="Featured stories"><article class="lead-story"><a class="lead-photo" href="${href(lead)}" tabindex="-1" aria-hidden="true">${picture(lead,'',true,'(max-width: 760px) calc(100vw - 38px), 65vw')}</a><div class="lead-content"><span class="eyebrow light-eyebrow"><span class="tiny-rule"></span> NEWS · FAITH & PUBLIC LIFE</span><h1><a href="${href(lead)}">${escape(lead.title)}</a></h1><p>${escape(lead.summary)}</p><div class="lead-bottom"><span>By ${escape(lead.author)} <span class="meta-dot">·</span> ${date(lead)}</span><a href="${href(lead)}" class="circle-link" aria-label="Read the lead story">${icon('arrow',21)}</a></div></div>${mark(lead,'lead-save')}</article><aside class="latest-rail"><div class="rail-heading"><span class="eyebrow">IN THE HEADLINES</span><span class="rail-rule"></span></div>${latest.map((s,i)=>`<article class="rail-story"><div><span class="eyebrow clay">${escape(s.category)}</span><h2><a href="${href(s)}">${escape(s.title)}</a></h2><time datetime="${s.dateGMT}">${date(s)}</time></div><a href="${href(s)}" tabindex="-1" aria-hidden="true">${picture(s,'',false,'110px')}</a></article>`).join('')}<a href="#section/news" class="text-link rail-link">More from the newsroom ${icon('arrow',18)}</a></aside></section><div class="mission-strip"><span class="eyebrow">WHY WE REPORT</span><p>Faith is part of public life.<br class="mobile-only"> It deserves a wider lens.</p><a href="#about" class="text-link">Our story ${icon('diagonal',16)}</a></div>
    ${import.meta.env.VITE_PUBLIC_CMS_URL ? '<section class="newsroom-home" id="newsroom-home" aria-label="Published newsroom reports" hidden></section>' : ''}<section class="news-section" id="latest">${heading('FROM THE NEWSROOM','The stories that matter.','<a class="text-link" href="#section/news">Explore the newsroom '+icon('arrow',17)+'</a>')}<div class="story-filters" aria-label="Filter latest stories">${['All','News','Business','Features','Opinion','Interviews'].map(c=>`<button data-filter="${c}" aria-pressed="${filter===c}" class="${filter===c?'selected':''}">${c}</button>`).join('')}</div><div class="story-grid" id="latest-grid">${homeStories()}</div><div class="load-more-wrap" id="load-more-wrap">${loadButton()}</div></section>
    <section class="perspective-section">${heading('PERSPECTIVE, NOT JUST HEADLINES','Room for a deeper read.','<a class="text-link" href="#section/opinion">Opinion & columns '+icon('arrow',17)+'</a>')}<div class="perspective-layout"><article class="perspective-feature"><a href="${href(byId(29276))}" class="perspective-photo" tabindex="-1" aria-hidden="true">${picture(byId(29276))}</a><div><span class="eyebrow clay">OPINION · REMEMBRANCE</span><h3><a href="${href(byId(29276))}">${escape(byId(29276).title)}</a></h3><p>${escape(byId(29276).summary)}</p><a class="text-link" href="${href(byId(29276))}">Read the perspective ${icon('arrow',18)}</a></div></article><div class="perspective-list">${[byId(29257),byId(29255),byId(29126)].map((s,i)=>`<article><span class="perspective-number">0${i+1}</span><div><span class="eyebrow clay">${escape(s.category)}</span><h3><a href="${href(s)}">${escape(s.title)}</a></h3><span class="muted small">${escape(s.author)}</span></div></article>`).join('')}</div></div></section>
    <section class="society-section">${heading('BEYOND THE CHURCH WALLS','Faith meets everyday life.','<a class="text-link" href="#section/health">Health & education '+icon('arrow',17)+'</a>')}<div class="society-grid">${[byId(28710),byId(28875),byId(28877)].map(s=>card(s)).join('')}</div></section>
    <section class="interview-feature"><div class="interview-image">${picture(byId(28527))}<span class="image-source">IMAGE FROM THE ORIGINAL CHURCH TIMES ARTICLE</span></div><div class="interview-copy"><span class="eyebrow light-eyebrow">IN CONVERSATION</span><h2>Lives of service.<br><em>Stories of faith.</em></h2><h3><a href="${href(byId(28527))}">${escape(byId(28527).title)}</a></h3><p>${escape(byId(28527).summary)}</p><a class="button button-light" href="${href(byId(28527))}">Explore the interview ${icon('arrow',18)}</a></div></section>
    <section class="publication-strip"><span class="eyebrow">CHURCH TIMES NIGERIA</span><h2>Reporting the church.<br><em>Understanding the world.</em></h2><p>News, features, conversations and perspectives on Christians in politics, business, education, health and beyond.</p><a class="text-link" href="#submit">Share a story with the newsroom ${icon('arrow',17)}</a><a class="text-link" href="#about">Meet the publication ${icon('diagonal',17)}</a></section></div>`, 'home');
  bindFilters();
  loadHomeReports();
}
function filteredHome(){return stories.filter(s=>filter==='All'||(filter==='Opinion'?s.categories.some(c=>['Opinion','Columnists'].includes(c)):s.categories.includes(filter)));}
function homeStories(){const list=filteredHome();return list.length?list.slice(0,limit).map(s=>card(s)).join(''):'<div class="empty-state"><h3>No stories in this selection.</h3><p>Choose another section.</p></div>';}
function loadButton(){return filteredHome().length>limit?`<button class="outline-button" id="load-more">More stories ${icon('down',17)}</button>`:`<span class="muted small">You’re up to date with this selection.</span>`;}
function bindFilters(){document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter;limit=6;document.querySelectorAll('[data-filter]').forEach(x=>{const active=x===b;x.classList.toggle('selected',active);x.setAttribute('aria-pressed',String(active));});refreshHome();}));bindLoad();}
function bindLoad(){document.querySelector('#load-more')?.addEventListener('click',()=>{const previous=document.querySelectorAll('#latest-grid .story-card').length;limit+=6;refreshHome(previous);});}
function refreshHome(focusIndex){document.querySelector('#latest-grid').innerHTML=homeStories();document.querySelector('#load-more-wrap').innerHTML=loadButton();bindSaves();bindLoad();const cards=document.querySelectorAll('#latest-grid .story-card');if(Number.isInteger(focusIndex))cards[focusIndex]?.querySelector('h3 a').focus({preventScroll:true});toast(`${cards.length} ${filter==='All'?'':filter+' '}stories shown.`);}
function intro(kicker,title,description){return `<section class="page-intro"><div class="container"><span class="eyebrow clay">${kicker}</span><h1>${title}</h1><p>${description}</p></div></section>`;}
function sectionPage(slug){const section=sections.find(s=>s.slug===slug);if(!section){notFound();return;}const list=stories.filter(s=>inSection(s,section));shell(`${intro('THE JOURNAL',section.name,section.description)}<section class="container section-list"><div class="listing-meta"><span>${list.length} selected ${list.length===1?'story':'stories'}</span><span>From the current Church Times publication</span></div><div class="story-grid">${list.map(s=>card(s)).join('')}</div><div class="source-note">Explore more from this section on <a href="https://churchtimesnigeria.net/category/${slug==='opinion'?'columnists':slug==='health'?'health':slug}/" target="_blank" rel="noopener noreferrer">the current website ${icon('diagonal',14)}</a>.</div></section>`,slug);}
function storyPage(slug){const s=stories.find(s=>s.slug===slug);if(!s){notFound();return;}const section=sections.find(x=>inSection(s,x));const related=stories.filter(x=>x.id!==s.id&&x.categories.some(c=>s.categories.includes(c))).slice(0,3);shell(`<article class="article-page container"><div class="breadcrumbs"><a href="#home">Home</a><span>/</span><a href="#section/${section?.slug||'news'}">${escape(s.category)}</a></div><header class="article-header"><span class="eyebrow clay">${escape(s.category)} · STORY BRIEFING</span><h1>${escape(s.title)}</h1><p class="article-deck">${escape(s.summary)}</p><div class="article-meta"><div class="author-avatar" aria-hidden="true">${s.author==='Church Times'?'CT':s.author.split(' ').map(x=>x[0]).slice(0,2).join('')}</div><div><strong>${escape(s.author)}</strong><span>Originally published ${date(s,true)}</span></div><div class="article-tools">${mark(s)}<button class="icon-button" data-share="${s.id}" aria-label="Copy original article link">${icon('share',19)}</button><a href="${s.source}" class="text-link" target="_blank" rel="noopener noreferrer">Original article ${icon('diagonal',15)}</a></div></div></header><figure class="article-figure">${picture(s,'',true,'(max-width: 1000px) calc(100vw - 38px), 1000px')}<figcaption>Image from the original Church Times Nigeria article. <a href="${s.imageSource}" target="_blank" rel="noopener noreferrer">View source ${icon('diagonal',12)}</a></figcaption></figure><div class="article-body-layout"><aside class="article-side"><span class="eyebrow">THE STORY AT A GLANCE</span><span class="article-side-line"></span><p>A concise briefing on a report from Church Times Nigeria.</p><a class="text-link" href="${s.source}" target="_blank" rel="noopener noreferrer">Read the full story ${icon('diagonal',15)}</a></aside><div class="article-body">${s.briefing.map(p=>`<p>${escape(p)}</p>`).join('')}<div class="original-callout"><span class="eyebrow">CONTINUE READING</span><h2>The full story,<br>in the original publication.</h2><p>This briefing introduces the report. Read the complete article, quotations and context on Church Times Nigeria.</p><a href="${s.source}" class="button button-dark" target="_blank" rel="noopener noreferrer">Read the original article ${icon('diagonal',17)}</a></div><div class="article-tags">${s.categories.map(c=>`<span>${escape(c)}</span>`).join('')}</div></div></div></article><section class="container related-section">${heading('KEEP EXPLORING','More to consider.')}<div class="story-grid">${related.map(x=>card(x)).join('')}</div></section>`,section?.slug||'news');document.querySelector('[data-share]').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(s.source);toast('Original article link copied.');}catch{openShareFallback(s.source);}});}
function searchPage(query){const terms=query.toLowerCase().split(/\s+/).filter(Boolean);const results=stories.filter(s=>terms.every(t=>`${s.title} ${s.summary} ${s.author} ${s.categories.join(' ')}`.toLowerCase().includes(t)));shell(`${intro('SEARCH THE JOURNAL',query?`Results for “${escape(query)}”`:'Find a story.','Explore headlines, topics and contributors from the current publication.')}<section class="container section-list"><form id="page-search" class="page-search"><label class="sr-only" for="page-search-input">Search stories</label><div class="search-input-wrap">${icon('search')}<input id="page-search-input" name="query" type="search" value="${escape(query)}" placeholder="Search the journal…" maxlength="120" required><button class="button button-dark">Search ${icon('arrow',17)}</button></div></form><div class="listing-meta"><span>${results.length} ${results.length===1?'story':'stories'} found</span></div><div class="story-grid">${results.length?results.map(s=>card(s)).join(''):'<div class="empty-state"><h2>No matching stories.</h2><p>Try a broader word, an author’s name or another topic.</p><a class="button button-dark" href="#home">Explore the journal '+icon('arrow',17)+'</a></div>'}</div></section>`,'search');document.querySelector('#page-search').addEventListener('submit',e=>{e.preventDefault();navigateSearch(document.querySelector('#page-search-input').value);});}
function savedPage(){const list=stories.filter(s=>saved.has(s.id));shell(`${intro('YOUR READING LIST','Worth returning to.','Save a story when it catches your attention. Your selection stays in this browser.')}<section class="container section-list"><div class="listing-meta"><span>${list.length} saved ${list.length===1?'story':'stories'}</span>${list.length?'<button class="text-button" id="clear-saved">Clear reading list</button>':''}</div><div class="story-grid">${list.length?list.map(s=>card(s)).join(''):'<div class="empty-state"><span class="empty-icon">'+icon('bookmark',38)+'</span><h2>A little room for good reading.</h2><p>Use the bookmark beside a story to save it for later.</p><a class="button button-dark" href="#home">Find a story '+icon('arrow',17)+'</a></div>'}</div></section>`,'saved');document.querySelector('#clear-saved')?.addEventListener('click',()=>{saved.clear();persistSaved();savedPage();toast('Reading list cleared.');});}
function about(){shell(`${intro('OUR STORY','A wider lens.<br><em>A lasting conviction.</em>','Professional journalism on the church, the people and the world we share.')}<section class="container about-layout"><div class="about-photo">${picture(byId(29259))}<span>From the current Church Times Nigeria publication</span></div><div class="about-copy"><span class="eyebrow clay">REPORTING WITH PURPOSE</span><h2>The story goes<br>beyond the pulpit.</h2><p>Church Times Nigeria is a publication of Churchtimes Agency Ltd. Its published mission reaches across politics, business, education, health and other spheres of life.</p><p>It brings together news, interviews, features, commentary and the publisher’s reflections, with the ambition to report the church professionally and give readers a wider understanding of Christians in society.</p><p>In the founder’s account supplied for this redesign, the publication began in April 2007 after a career at The Punch. The vision was to bring the standards of secular journalism to church reporting—and follow the story into the wider economy.</p><a href="https://churchtimesnigeria.net/" class="text-link" target="_blank" rel="noopener noreferrer">Explore the existing publication ${icon('diagonal',17)}</a></div></section><section class="container about-principles">${heading('THE DIRECTION OF OUR JOURNALISM','Faith. People. Public life.')}<div class="principle-grid">${[['01','Follow the story','Look beyond events to the people, decisions and institutions shaping public life.'],['02','Make room for context','Distinguish reported accounts, personal perspectives and theological commentary.'],['03','Keep the reader in view','Present stories clearly, identify contributors and make the original context easy to find.']].map(([n,t,p])=>`<article><span>${n}</span><h3>${t}</h3><p>${p}</p></article>`).join('')}</div></section><section class="container contact-callout"><div><span class="eyebrow">START A CONVERSATION</span><h2>Have a story worth telling?</h2><p>Contact the newsroom with news, corrections or an enquiry.</p></div><a class="button button-dark" href="#contact">Get in touch ${icon('arrow',18)}</a></section>`,'about');}
function contact(){shell(`${intro('CONTACT THE NEWSROOM','The next story<br><em>starts with a conversation.</em>','News tips, reader correspondence and commercial enquiries for Church Times Nigeria.')}<section class="container contact-layout"><div class="contact-primary"><span class="eyebrow clay">EMAIL THE PUBLICATION</span><h2>Let’s hear from you.</h2><a class="contact-email" href="mailto:info@churchtimesnigeria.net">info@churchtimesnigeria.net ${icon('diagonal',23)}</a><p>For a news tip or correction, include the relevant article link and enough detail for the newsroom to understand your enquiry.</p><div class="contact-divider"></div><span class="eyebrow">NAMED CONTACT ON THE CURRENT SITE</span><a class="text-link" href="mailto:gbengaosinaike@churchtimesnigeria.net">gbengaosinaike@churchtimesnigeria.net ${icon('mail',17)}</a></div><aside class="contact-details"><span class="eyebrow">CHURCHTIMES AGENCY LTD</span><h3>Find the publication.</h3><address>14, Oladele Street<br>Dominion Estate<br>Ota, Ogun State<br>Nigeria</address><span class="eyebrow">CALL</span><a href="tel:+2348033336243">+234 803 333 6243</a><a href="tel:+2348023453568">+234 802 345 3568</a><p class="muted small">Contact details as published on the current website. <a href="https://churchtimesnigeria.net/contact-us/" target="_blank" rel="noopener noreferrer">View the contact page ${icon('diagonal',12)}</a></p></aside></section>${publicFormMarkup('contact')}<section class="container contact-callout"><div><span class="eyebrow">COMMERCIAL ENQUIRIES</span><h2>Reach an engaged community.</h2><p>Discuss advertising, publishing and special-edition opportunities.</p></div><a class="button button-dark" href="#advertise">Explore advertising ${icon('arrow',18)}</a></section>`,'contact');disposePublicForm=bindPublicForm('contact');}
function advertise(){shell(`${intro('ADVERTISE WITH CHURCH TIMES','A considered audience.<br><em>A meaningful conversation.</em>','Talk to the publication about print and digital advertising, publishing projects and special editions.')}<section class="container advert-intro"><div><span class="eyebrow clay">THE COMMERCIAL CONVERSATION</span><h2>Build a clear brief.<br>Make a useful connection.</h2><p>The current Church Times site publishes a print advertising rate card and carries commercial placements. Contact the publication to confirm today’s options, availability, pricing and tax treatment.</p><p>Start with your objective, intended audience, campaign dates and budget. Request written deliverables and clear advertising labels before committing.</p><a class="button button-dark" href="mailto:info@churchtimesnigeria.net?subject=Advertising%20enquiry%20%E2%80%94%20Church%20Times%20Nigeria">Enquire about advertising ${icon('mail',17)}</a></div><div class="advert-card"><span class="eyebrow">CURRENT PUBLICATION</span><span class="advert-monogram" aria-hidden="true">CT<i>.</i></span><h3>News. Ideas.<br>Public life.</h3><a class="text-link" href="https://churchtimesnigeria.net/advert/" target="_blank" rel="noopener noreferrer">View the existing print rate card ${icon('diagonal',17)}</a><small>Confirm current rates directly with the publication.</small></div></section><section class="container commercial-grid">${[['Print placements','Discuss the print formats and special placements listed in the publication’s existing rate card.'],['Digital campaigns','Ask about current website placements, formats, campaign reporting and available inventory.'],['Special editions','Agree a costed brief, production schedule, rights, disclosures and payment terms with the publisher.']].map(([t,p])=>`<article><span class="small-rule"></span><h3>${t}</h3><p>${p}</p></article>`).join('')}</section><section class="container commercial-boundary"><span class="eyebrow clay">A STANDARD FOR THE NEW DESIGN</span><h2>Advertising should<br>be recognisable as advertising.</h2><p>Paid placements deserve clear labels. Editorial reporting and commercial agreements should have distinct responsibilities and expectations.</p><a href="#contact" class="text-link">Talk to the publication ${icon('arrow',17)}</a></section>`,'advertise');}
function submissionPage(){
  shell(`${intro('PUBLIC STORY SUBMISSIONS','A story worth telling.<br><em>A newsroom ready to listen.</em>','Share a story or tip with Church Times Nigeria for editorial review.')} ${publicFormMarkup('story')}`,'submit');
  disposePublicForm=bindPublicForm('story');
}
function notFound(){shell(`${intro('THE JOURNAL','A different path.<br><em>The story continues.</em>','This page is not in the selected edition. Explore the journal or search for a story.')}<div class="container empty-state"><a class="button button-dark" href="#home">Back to the journal ${icon('arrow',17)}</a></div>`,'404');}
function navigateSearch(query){const clean=query.trim().slice(0,120);location.hash=`search/${encodeURIComponent(clean)}`;}
function persistSaved(){try{localStorage.setItem('ct-reading-list',JSON.stringify([...saved]));}catch{toast('Saved for this visit. Browser storage is unavailable.');}}
function toast(message){const t=document.querySelector('#toast');if(!t)return;t.textContent=message;t.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('visible'),3000);}
function bindSaves(){document.querySelectorAll('[data-save]').forEach(b=>{b.onclick=()=>{const id=Number(b.dataset.save),s=byId(id);if(saved.has(id)){saved.delete(id);toast('Removed from your reading list.');}else{saved.add(id);toast('Saved to your reading list.');}persistSaved();document.querySelectorAll(`[data-save="${id}"]`).forEach(x=>{const active=saved.has(id);x.classList.toggle('is-saved',active);x.setAttribute('aria-pressed',String(active));x.setAttribute('aria-label',`${active?'Remove from':'Save to'} reading list: ${s.title}`);});const count=document.querySelector('#saved-count');count.textContent=saved.size;count.hidden=!saved.size;document.querySelector('.reading-link').setAttribute('aria-label',`Reading list, ${saved.size} saved stories`);if(location.hash==='#saved')savedPage();};});}
function openShareFallback(url){const d=document.querySelector('#share-dialog');const input=d.querySelector('input');input.value=url;d.showModal();input.focus();input.select();}
function openDialog(id, trigger){const d=document.querySelector(id);trigger?.setAttribute('aria-expanded','true');d.addEventListener('close',()=>trigger?.setAttribute('aria-expanded','false'),{once:true});d.showModal();}
function bindCommon(){bindSaves();document.querySelector('#select-share-url').addEventListener('click',()=>{const input=document.querySelector('#share-url');input.focus();input.select();});document.querySelector('[data-search]').addEventListener('click',()=>{openDialog('#search-dialog',document.querySelector('[data-search]'));document.querySelector('#search-input').focus();});document.querySelector('[data-menu]').addEventListener('click',()=>openDialog('#menu-dialog',document.querySelector('[data-menu]')));document.querySelector('[data-privacy]').addEventListener('click',()=>document.querySelector('#privacy-dialog').showModal());document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));document.querySelector('#search-form').addEventListener('submit',e=>{e.preventDefault();document.querySelector('#search-dialog').close();navigateSearch(document.querySelector('#search-input').value);});document.querySelectorAll('[data-query]').forEach(b=>b.addEventListener('click',()=>{document.querySelector('#search-dialog').close();navigateSearch(b.dataset.query);}));document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target!==d)return;const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}));}

const cmsUrl = import.meta.env.VITE_PUBLIC_CMS_URL;
const reportHref = article => `#report/${article.slug}`;
function reportDate(article) {
  return article.publishedAt ? `<time datetime="${escape(article.publishedAt)}">${date({dateGMT:article.publishedAt},true)}</time>` : '';
}
function reportCard(article) {
  return `<article class="story-card newsroom-card"><div class="newsroom-card-meta"><span class="eyebrow clay">${escape(article.category || 'Newsroom')}</span>${reportDate(article)}</div><h2><a href="${reportHref(article)}">${escape(article.title)}</a></h2><p>${escape(article.excerpt)}</p><a class="text-link" href="${reportHref(article)}" aria-label="Read article: ${escape(article.title)}">Read article ${icon('arrow',18)}</a></article>`;
}
function feedState(target, title, description, retry) {
  const tag = target.id === 'cms-report' ? 'h1' : 'h2';
  target.innerHTML = `<div class="newsroom-state"><${tag}>${title}</${tag}><p role="status">${description}</p><div class="newsroom-state-actions">${retry ? '<button class="outline-button" id="retry-feed">Try again</button>' : ''}<a class="text-link" href="#home">Explore the current edition ${icon('arrow',17)}</a></div></div>`;
  if (tag === 'h1') document.title = `${title} — Church Times Nigeria`;
  if (retry) target.querySelector('#retry-feed').addEventListener('click',retry);
}
async function loadHomeReports() {
  const target = document.querySelector('#newsroom-home');
  if (!target) return;
  try {
    const { articles } = await fetchPublishedPage({baseUrl:cmsUrl,signal:routeController.signal,limit:3});
    if (!target.isConnected || !articles.length) return;
    target.innerHTML = `${heading('JUST PUBLISHED','From the newsroom.',`<a class="text-link" href="#latest">All newsroom reports ${icon('arrow',17)}</a>`)}<div class="story-grid">${articles.map(reportCard).join('')}</div>`;
    target.hidden = false;
  } catch { /* The independently available static edition remains the homepage. */ }
}
async function latestPage() {
  shell(`${intro('THE NEWSROOM','The latest reports.','Published reporting from Church Times Nigeria.')}<section class="container section-list newsroom-feed"><div id="cms-latest" aria-busy="true"><p role="status">Loading published reports…</p></div></section>`, 'latest');
  const target = document.querySelector('#cms-latest');
  if (!cmsUrl) {
    target.setAttribute('aria-busy','false');
    feedState(target,'The newsroom is taking shape.','Read our current edition while the new newsroom feed is being prepared.');
    return;
  }
  const seen = new Set();
  let grid;
  async function load(page=1) {
    target.setAttribute('aria-busy','true');
    const previousButton = target.querySelector('#more-reports, #retry-feed, #newsroom-more button');
    const restoreFocus = target.contains(document.activeElement);
    const previousCount = seen.size;
    if (previousButton) { previousButton.disabled = true; previousButton.textContent = 'Loading reports…'; }
    try {
      const { articles, nextPage } = await fetchPublishedPage({baseUrl:cmsUrl,signal:routeController.signal,page,limit:12});
      if (!target.isConnected) return;
      if (!grid && !articles.length && !nextPage) {
        feedState(target,'More stories are on their way.','No newsroom reports have been published yet.');
        return;
      }
      if (!grid) {
        target.innerHTML = '<p class="sr-only" aria-live="polite" aria-atomic="true" id="feed-announcement"></p><div class="story-grid" id="newsroom-grid"></div><div class="load-more-wrap" id="newsroom-more"></div>';
        grid = target.querySelector('#newsroom-grid');
      }
      const fresh = articles.filter(article => { if (seen.has(article.slug)) return false; seen.add(article.slug); return true; });
      grid.insertAdjacentHTML('beforeend',fresh.map(reportCard).join(''));
      target.querySelector('#feed-announcement').textContent = `${fresh.length} ${fresh.length===1?'report':'reports'} loaded. ${seen.size} ${seen.size===1?'report':'reports'} shown.`;
      const more = target.querySelector('#newsroom-more');
      more.innerHTML = nextPage ? '<button class="outline-button" id="more-reports">More reports '+icon('down',17)+'</button>' : '<p class="muted small" role="status">You’re up to date with the newsroom.</p>';
      more.querySelector('button')?.addEventListener('click',() => load(nextPage));
    } catch {
      if (!target.isConnected) return;
      if (grid) {
        const more = target.querySelector('#newsroom-more');
        more.innerHTML = '<p role="status">More reports could not be loaded. Your stories are still here.</p><button class="outline-button">Try again</button>';
        more.querySelector('button').addEventListener('click',() => load(page));
      } else feedState(target,'We couldn’t reach the newsroom.','Please try again, or keep reading the current edition.',() => load(page));
    } finally { if (target.isConnected) { target.setAttribute('aria-busy','false'); if (restoreFocus) { const next = grid?.querySelectorAll('h2 a')[previousCount] || target.querySelector('button') || target.querySelector('h2'); if (next?.tagName === 'H2') next.tabIndex = -1; next?.focus({preventScroll:true}); } } }
  }
  await load();
}
async function reportPage(slug) {
  shell(`<section class="container section-list newsroom-report" id="cms-report" aria-busy="true"><div class="breadcrumbs"><a href="#home">Home</a><span>/</span><a href="#latest">Latest reports</a></div><h1 class="sr-only">Newsroom article</h1><p role="status">Loading article…</p></section>`,'latest');
  const target = document.querySelector('#cms-report');
  if (!cmsUrl) {
    target.setAttribute('aria-busy','false');
    feedState(target,'The newsroom is taking shape.','Read our current edition while the new newsroom feed is being prepared.');
    return;
  }
  async function load() {
    target.setAttribute('aria-busy','true');
    const restoreFocus = target.contains(document.activeElement);
    target.querySelector('button')?.setAttribute('disabled','');
    try {
      const article = await fetchPublishedArticle({baseUrl:cmsUrl,signal:routeController.signal,slug});
      if (!target.isConnected) return;
      if (!article) {
        target.innerHTML = `${intro('THE NEWSROOM','Article unavailable.','This report is not available in the published edition.')}<a class="button button-dark" href="#latest">Browse published reports ${icon('arrow',17)}</a>`;
        document.title = 'Article unavailable — Church Times Nigeria';
        return;
      }
      const body = renderArticleContent(article.content);
      target.innerHTML = `<div class="breadcrumbs"><a href="#home">Home</a><span>/</span><a href="#latest">Latest reports</a></div><article><header class="article-header"><span class="eyebrow clay">${escape(article.category || 'Newsroom')}</span><h1>${escape(article.title)}</h1><p class="article-deck">${escape(article.excerpt)}</p><div class="article-meta">${reportDate(article)}<button class="icon-button" id="share-report" aria-label="Copy article link">${icon('share',19)}</button></div></header><div class="newsroom-article-body article-body">${body || '<p>The full article text is not available yet. Please check back shortly.</p>'}</div><div class="newsroom-article-end"><a class="text-link" href="#latest">More from the newsroom ${icon('arrow',17)}</a></div></article>`;
      document.title = `${article.title} — Church Times Nigeria`;
      document.querySelector('meta[name="description"]').content = article.excerpt;
      target.querySelector('#share-report').addEventListener('click',async() => {
        try { await navigator.clipboard.writeText(location.href); toast('Article link copied.'); }
        catch { openShareFallback(location.href); }
      });
    } catch {
      if (target.isConnected) feedState(target,'We couldn’t load this report.','Please try again. The current edition is still available.',load);
    } finally { if (target.isConnected) { target.setAttribute('aria-busy','false'); if (restoreFocus) { const next=target.querySelector('button, h1'); if(next?.tagName==='H1')next.tabIndex=-1; next?.focus({preventScroll:true}); } } }
  }
  await load();
}

function render(){let parts;try{parts=decodeURIComponent(location.hash.slice(1)).split('/');}catch{parts=['404'];}const [route='home',...rest]=parts;const param=rest.join('/');const pages={home,about,contact,advertise,submit:submissionPage,saved:savedPage};if(route==='main'){if(!document.querySelector('#main'))home();document.querySelector('#main').focus();return;}if(route==='connect'){if(!document.querySelector('#connect'))home();requestAnimationFrame(()=>document.querySelector('#connect').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));return;}if(route==='section')sectionPage(param);else if(route==='story')storyPage(param);else if(route==='search')searchPage(param);else if(route==='latest')latestPage();else if(route==='report')reportPage(param);else if(pages[route])pages[route]();else if(!route)home();else notFound();const heading=document.querySelector('h1')?.textContent||'The journal';document.title=`${heading} — Church Times Nigeria`;document.querySelector('meta[name="description"]').content=document.querySelector('.article-deck')?.textContent||'Church Times Nigeria: news, features, interviews and perspectives on faith and public life.';window.scrollTo({top:0,behavior:'instant'});}
window.addEventListener('hashchange',()=>{
  render();
  if (!['#main','#connect'].includes(location.hash)) document.querySelector('#main')?.focus({preventScroll:true});
});
render();
