// Single lazy entry for the growth features. src/main.js only ever does `import('./features/growth/hooks.js')`, so none
// of this (nor its stylesheet) is in the initial bundle. Each feature is a further chunk loaded only when needed.
import './growth.css';
import { readFollows, whatsappDismissed } from './storage.js';

export const searchDialog = (api, dialog) => import('./search-suggest.js').then(m => m.mountSearchSuggest(dialog, api));
export const searchPage = (api, options) => import('./search-page.js').then(m => m.mountSearchPage(api, options));
export const topicPage = (api, slug) => import('./topic-page.js').then(m => m.mountTopicPage(api, slug));

/** Runs once a route has finished drawing (and the browser is idle): follow buttons, Following feed, WhatsApp prompt. */
export async function afterRender(api) {
  const main = document.querySelector('#main');
  if (!main) return;
  const jobs = [];
  if (main.querySelector('button[data-follow-kind]')) jobs.push(import('./follow.js').then(m => m.bindFollowButtons(main)));
  const home = main.querySelector('#home-editorial');
  if (home && api.cmsUrl && readFollows().length) jobs.push(import('./following-feed.js').then(m => m.mountFollowingFeed(api, main.querySelector('#newsroom-home') || home)));
  if (!whatsappDismissed()) {
    const reportEnd = main.querySelector('.newsroom-article-end');
    const storyEnd = main.querySelector('.original-callout');
    const place = reportEnd ? [reportEnd, 'beforebegin'] : storyEnd ? [storyEnd, 'beforebegin'] : home ? [home, 'afterend'] : null;
    if (place) {
      await Promise.allSettled(jobs);
      // On the home page the prompt goes after the Following section when there is one.
      const anchor = home && !reportEnd && !storyEnd ? main.querySelector('#growth-following') || main.querySelector('#newsroom-home') || home : place[0];
      jobs.push(import('./whatsapp.js').then(m => m.mountWhatsappPrompt(anchor, { position: anchor === place[0] ? place[1] : 'afterend' })));
    }
  }
  await Promise.allSettled(jobs);
}
