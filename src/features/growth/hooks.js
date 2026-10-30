// Single lazy entry for the growth features. src/main.js only ever does `import('./features/growth/hooks.js')`, so none
// of this (nor its stylesheet) is in the initial bundle. Each feature is a further chunk loaded only when needed.
import './growth.css';
import { readFollows, whatsappDismissed } from './storage.js';

export const searchDialog = (api, dialog) => import('./search-suggest.js').then(m => m.mountSearchSuggest(dialog, api));
export const searchPage = (api, options) => import('./search-page.js').then(m => m.mountSearchPage(api, options));
export const topicPage = (api, slug) => import('./topic-page.js').then(m => m.mountTopicPage(api, slug));
const scripture = () => import('./scripture/index.js');

// Scripture reference cards attach listeners to the article body and the document; remove them when the route changes.
let disposeScripture = null;
const releaseScripture = () => { try { disposeScripture?.(); } catch { /* the old body is already gone */ } disposeScripture = null; };
addEventListener('hashchange', releaseScripture);
addEventListener('popstate', releaseScripture);

/** Runs once a route has finished drawing (and the browser is idle): follow buttons, scripture, Following feed, verse, WhatsApp prompt. */
export async function afterRender(api) {
  releaseScripture();
  const main = document.querySelector('#main');
  if (!main) return;
  const jobs = [];
  if (main.querySelector('button[data-follow-kind]')) jobs.push(import('./follow.js').then(m => m.bindFollowButtons(main)));
  const reportBody = main.querySelector('.newsroom-article-body');
  if (reportBody) jobs.push(scripture().then(m => { if (reportBody.isConnected) disposeScripture = m.mountScriptureRefs(reportBody); }));
  const home = main.querySelector('#home-editorial');
  if (home) {
    // Home order: newsroom reports, Following (only when the reader follows something), verse of the day, WhatsApp prompt.
    if (api.cmsUrl && readFollows().length) await import('./following-feed.js').then(m => m.mountFollowingFeed(api, main.querySelector('#newsroom-home') || home)).catch(() => {});
    if (!home.isConnected) return;
    let anchor = main.querySelector('#growth-following') || main.querySelector('#newsroom-home') || home;
    if (!main.querySelector('#growth-verse')) {
      const verse = document.createElement('section');
      verse.id = 'growth-verse';
      verse.className = 'container growth-verse';
      verse.setAttribute('aria-label', 'Verse of the day');
      verse.hidden = true; // shown by mountDailyVerse once the bundled text has loaded; stays hidden if it cannot

      anchor.insertAdjacentElement('afterend', verse);
      jobs.push(scripture().then(m => m.mountDailyVerse(verse)).catch(() => verse.remove()));
      anchor = verse;
    }
    if (!whatsappDismissed()) jobs.push(import('./whatsapp.js').then(m => m.mountWhatsappPrompt(anchor)));
  } else if (!whatsappDismissed()) {
    const end = main.querySelector('.newsroom-article-end') || main.querySelector('.original-callout');
    if (end) jobs.push(import('./whatsapp.js').then(m => m.mountWhatsappPrompt(end, { position: 'beforebegin' })));
  }
  await Promise.allSettled(jobs);
}
