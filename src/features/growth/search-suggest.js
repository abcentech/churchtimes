// Search-as-you-type for the header search dialog (ARIA 1.2 combobox with a listbox popup) plus recent searches.
// Suggestions come from the existing public search endpoint (GET /api/public/search, limit 5), debounced, with the
// in-flight request aborted on every keystroke and a pause after a 429. Server text is only ever set as textContent.
import { searchArticles } from '../../lib/public-search.js';
import { highlightElements } from './highlight.js';
import { readRecentSearches, clearRecentSearches } from './storage.js';

export const SUGGEST_MIN_CHARS = 3;
export const SUGGEST_DEBOUNCE_MS = 300;
export const SUGGEST_LIMIT = 5;
const mounted = new WeakSet();

/** True when a suggestion request should be made for this input right now. Pure. */
export function shouldSuggest(value, { online = true, pausedUntil = 0, now = Date.now(), configured = true } = {}) {
  return configured && online && now >= pausedUntil && typeof value === 'string' && value.trim().length >= SUGGEST_MIN_CHARS;
}

const dateText = value => { try { return value ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' }).format(new Date(value)) : ''; } catch { return ''; } };

export function mountSearchSuggest(dialog, api) {
  if (!dialog || mounted.has(dialog)) return;
  const input = dialog.querySelector('#search-input');
  const form = dialog.querySelector('#search-form');
  if (!input || !form) return;
  mounted.add(dialog);
  const doc = dialog.ownerDocument;
  const listId = 'search-suggest-list';
  const list = doc.createElement('ul');
  list.id = listId; list.className = 'growth-suggest'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Search suggestions'); list.hidden = true;
  const status = doc.createElement('p');
  status.className = 'growth-suggest-status small'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  (form.querySelector('.search-input-wrap') || input).after(list, status);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listId);

  let options = [], active = -1, timer = 0, controller = null, pausedUntil = 0, lastQuery = '';
  const configured = Boolean(api.cmsUrl);
  const close = () => { list.hidden = true; list.replaceChildren(); options = []; active = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
  // Hide keeps the options so Down Arrow can reopen them (APG combobox); close drops them.
  const hide = () => { list.hidden = true; active = -1; options.forEach(o => o.el.setAttribute('aria-selected', 'false')); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
  const setActive = index => {
    active = options.length ? (index + options.length) % options.length : -1;
    options.forEach((o, i) => o.el.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) { input.setAttribute('aria-activedescendant', options[active].el.id); options[active].el.scrollIntoView?.({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  };
  const choose = option => {
    if (!option) return;
    dialog.close?.();
    if (option.href) {
      // Let the app's own link handling do the navigation (same path as clicking a story card).
      const link = doc.createElement('a'); link.href = option.href; link.hidden = true; doc.body.append(link); link.click(); link.remove();
    } else api.navigateSearch(option.query);
  };
  const addOption = (build, value) => {
    const el = doc.createElement('li');
    el.id = `search-suggest-${options.length}`; el.setAttribute('role', 'option'); el.setAttribute('aria-selected', 'false');
    build(el);
    const option = { el, ...value };
    el.addEventListener('mousedown', event => event.preventDefault());
    el.addEventListener('click', () => choose(option));
    options.push(option);
    list.append(el);
  };
  const render = (articles, query) => {
    list.replaceChildren(); options = []; active = -1;
    for (const article of articles) {
      addOption(el => {
        const title = doc.createElement('span'); title.className = 'growth-suggest-title'; title.textContent = article.title;
        const meta = doc.createElement('span'); meta.className = 'growth-suggest-meta'; meta.textContent = [article.category, dateText(article.publishedAt)].filter(Boolean).join(' · ');
        el.append(title, meta);
        highlightElements([title], query, doc);
      }, { href: api.reportHref(article) });
    }
    addOption(el => { el.className = 'growth-suggest-all'; el.textContent = `Search all stories for “${query}”`; }, { query });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    status.textContent = articles.length ? `${articles.length} ${articles.length === 1 ? 'suggestion' : 'suggestions'} available. Use the up and down arrows to choose.` : 'No quick matches. Press Enter to search all stories.';
  };

  const request = async () => {
    const query = input.value.trim().slice(0, 120);
    if (query === lastQuery && !list.hidden) return;
    lastQuery = query;
    controller?.abort();
    if (!shouldSuggest(query, { online: navigator.onLine, pausedUntil, configured })) {
      close();
      if (configured && !navigator.onLine && query.length >= SUGGEST_MIN_CHARS) status.textContent = 'You are offline, so suggestions are unavailable.';
      else if (Date.now() < pausedUntil) status.textContent = 'Suggestions are paused for a moment. Press Enter to search.';
      else status.textContent = '';
      return;
    }
    controller = new AbortController();
    const { signal } = controller;
    try {
      const { articles } = await searchArticles({ baseUrl: api.cmsUrl, query, limit: SUGGEST_LIMIT, signal, timeoutMs: 4000 });
      if (signal.aborted || input.value.trim().slice(0, 120) !== query) return;
      render(articles.slice(0, SUGGEST_LIMIT), query);
    } catch (error) {
      if (signal.aborted || error?.type === 'cancelled') return;
      close();
      if (error?.status === 429) { pausedUntil = Date.now() + Math.max(5, error.retryAfter || 30) * 1000; status.textContent = 'Suggestions are paused for a moment. Press Enter to search.'; }
      else status.textContent = 'Suggestions are unavailable right now. Press Enter to search.';
    }
  };

  input.addEventListener('input', () => { clearTimeout(timer); lastQuery = ''; timer = setTimeout(request, SUGGEST_DEBOUNCE_MS); if (input.value.trim().length < SUGGEST_MIN_CHARS) { controller?.abort(); close(); status.textContent = ''; } });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (list.hidden) { if (options.length) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); } else return; }
      event.preventDefault();
      setActive(active < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1) : active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' && !list.hidden && active >= 0) {
      event.preventDefault();
      choose(options[active]);
    } else if (event.key === 'Escape' && !list.hidden) {
      // First Escape closes the popup only; the next one closes the dialog as usual.
      event.preventDefault(); event.stopPropagation();
      controller?.abort(); hide();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (doc.activeElement !== input) hide(); }, 0));
  input.addEventListener('focus', () => { if (options.length && input.value.trim().length >= SUGGEST_MIN_CHARS) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); } });
  dialog.addEventListener('close', () => { clearTimeout(timer); controller?.abort(); close(); status.textContent = ''; });
  dialog.addEventListener('cancel', event => { if (!list.hidden) { event.preventDefault(); hide(); } });

  // Recent searches (this browser only), shown above the topic shortcuts.
  const recentBox = doc.createElement('div');
  recentBox.className = 'growth-recent';
  const anchor = dialog.querySelector('.search-suggestions');
  const paintRecent = () => {
    const recent = readRecentSearches();
    recentBox.replaceChildren();
    recentBox.hidden = !recent.length;
    if (!recent.length) return;
    const label = doc.createElement('span'); label.className = 'eyebrow'; label.id = 'growth-recent-label'; label.textContent = 'RECENT SEARCHES';
    const ul = doc.createElement('ul'); ul.setAttribute('aria-labelledby', 'growth-recent-label');
    for (const query of recent) {
      const li = doc.createElement('li'); const button = doc.createElement('button'); button.type = 'button'; button.textContent = query;
      button.addEventListener('click', () => { dialog.close?.(); api.navigateSearch(query); });
      li.append(button); ul.append(li);
    }
    const clear = doc.createElement('button'); clear.type = 'button'; clear.className = 'text-button growth-recent-clear'; clear.textContent = 'Clear recent searches';
    clear.addEventListener('click', () => { clearRecentSearches(); paintRecent(); status.textContent = 'Recent searches cleared.'; input.focus(); });
    recentBox.append(label, ul, clear);
  };
  paintRecent();
  if (anchor) anchor.before(recentBox); else dialog.append(recentBox);
  if (input.value.trim().length >= SUGGEST_MIN_CHARS) timer = setTimeout(request, SUGGEST_DEBOUNCE_MS);
}
