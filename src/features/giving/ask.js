// "Support our journalism" ask (lazy, loaded when the browser is idle). Shown only when the CMS reports giving as
// enabled; one small settings request per 10 minutes per tab, none at all with Save-Data. It never blocks reading:
// it adds a link to the footer and a short note after the article body once that body exists.
import { givingEnabled } from './settings-cache.js';
import './ask.css';

const ASK = '<aside class="give-ask" aria-labelledby="give-ask-title"><h2 id="give-ask-title">Support our journalism</h2><p>Church Times Nigeria is free to read. If this reporting helped you, a one-time gift keeps it independent.</p><a class="button button-dark" href="give/">Give to Church Times</a></aside>';
let observer;

function place(root) {
  if (root.querySelector('.give-page')) return true;
  const body = root.querySelector('article .article-body');
  if (!body) return false;
  const article = body.closest('article');
  if (!article.querySelector('.give-ask')) (article.querySelector('.share-bar') || body).insertAdjacentHTML('afterend', ASK);
  return true;
}

export async function mountGivingAsk(doc = document) {
  if (navigator.connection?.saveData) return;
  if (!(await givingEnabled())) return;
  const footer = doc.querySelector('.site-footer .footer-main > div:last-child');
  if (footer && !footer.querySelector('[data-give-link]')) footer.insertAdjacentHTML('beforeend', '<a href="give/" data-give-link>Support our journalism</a>');
  const main = doc.querySelector('#main');
  if (!main || place(main)) return;
  // Report pages fill in after their fetch: watch briefly, then stop.
  observer?.disconnect();
  observer = new MutationObserver(() => { if (place(main)) observer.disconnect(); });
  observer.observe(main, { childList: true, subtree: true });
  setTimeout(() => observer?.disconnect(), 20000);
}
