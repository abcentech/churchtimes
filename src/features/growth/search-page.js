// Search results page extras: remembers the query (this browser only), highlights query terms in result cards,
// adds section + year filters for the newsroom search (C8 `category` and `year` parameters) and handles offline.
import { fetchPublicCategories } from '../../lib/published-articles.js';
import { highlightElements } from './highlight.js';
import { rememberSearch } from './storage.js';

export const FIRST_ARCHIVE_YEAR = 2008;
export function yearOptions(now = new Date()) {
  const current = now.getFullYear();
  return Array.from({ length: Math.max(1, current - FIRST_ARCHIVE_YEAR + 1) }, (_, i) => current - i);
}
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CARD_TEXT = '.story-card h2 a, .story-card h3 a, .story-card > p, .story-card .card-copy > p';

export function mountSearchPage(api, { query }) {
  const term = typeof query === 'string' ? query.trim() : '';
  if (!term) return;
  rememberSearch(term);
  const main = document.querySelector('#main');
  if (!main) return;
  const paint = root => highlightElements([...root.querySelectorAll(CARD_TEXT)].filter(el => !el.dataset.growthMarked && (el.dataset.growthMarked = '1')), term);
  paint(main);
  // Newsroom results arrive asynchronously (and on "More reports"): highlight each batch as it is inserted.
  const observer = new MutationObserver(() => paint(main));
  observer.observe(main, { childList: true, subtree: true });
  const stop = () => observer.disconnect();
  addEventListener('hashchange', stop, { once: true });
  addEventListener('popstate', stop, { once: true });

  const results = document.querySelector('#cms-search');
  if (!results || !api.cmsUrl) return;
  const block = results.parentElement;
  const filters = document.createElement('form');
  filters.className = 'growth-search-filters';
  filters.setAttribute('aria-label', 'Filter newsroom results');
  filters.innerHTML = `<div><label for="growth-filter-category">Section</label><select id="growth-filter-category" name="category"><option value="">All sections</option></select></div><div><label for="growth-filter-year">Year</label><select id="growth-filter-year" name="year"><option value="">Any year</option>${yearOptions().map(y => `<option value="${y}">${y}</option>`).join('')}</select></div><button type="reset" class="text-button">Clear filters</button><p class="growth-note" role="status" aria-live="polite"></p>`;
  block.querySelector('h2')?.after(filters);
  const note = filters.querySelector('[role=status]');
  const categorySelect = filters.querySelector('#growth-filter-category');
  fetchPublicCategories({ baseUrl: api.cmsUrl }).then(({ articles }) => {
    if (!filters.isConnected) return;
    categorySelect.insertAdjacentHTML('beforeend', articles.map(c => `<option value="${escape(c.slug)}">${escape(c.title)}</option>`).join(''));
  }).catch(() => { if (filters.isConnected) categorySelect.closest('div').hidden = true; });

  let current = results;
  const run = () => {
    const category = categorySelect.value, year = filters.querySelector('#growth-filter-year').value;
    // A fresh target makes any in-flight load for the old filters drop its result (it checks isConnected).
    const next = document.createElement('div');
    next.id = 'cms-search'; next.setAttribute('aria-busy', 'true');
    current.replaceWith(next); current = next;
    const label = [categorySelect.selectedOptions[0]?.value ? categorySelect.selectedOptions[0].textContent : '', year].filter(Boolean).join(', ');
    note.textContent = label ? `Showing results filtered by ${label}.` : 'Showing all newsroom results.';
    api.latestPage({ target: next, query: term, filters: { category: category || undefined, year: year || undefined } });
  };
  filters.addEventListener('change', run);
  filters.addEventListener('reset', () => setTimeout(run, 0));
  filters.addEventListener('submit', event => { event.preventDefault(); run(); });

  if (!navigator.onLine) note.textContent = 'You are offline. Newsroom search needs a connection; it will retry when you reconnect.';
  addEventListener('online', () => {
    if (!filters.isConnected) return;
    note.textContent = 'You are back online.';
    if (current.querySelector('#retry-feed')) run();
  }, { once: true });
}
