// "Following" feed: the newest published stories from the topics and authors this reader follows (stored locally).
// Fetches each followed item from the public API, merges, de-duplicates and sorts newest first. The last good result is
// kept in localStorage so the section still works offline (shown with a "saved" note).
import { fetchTaxonomy, validTaxonomySlug } from './taxonomy-api.js';
import { normalizePublishedArticle } from '../../lib/published-articles.js';
import { readFollows, readJSON, writeJSON, toggleFollow, FOLLOW_FEED_CACHE_KEY } from './storage.js';

export const FEED_FOLLOW_LIMIT = 12;
export const FEED_STORY_LIMIT = 12;
const CONCURRENCY = 4;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const followsKey = follows => follows.map(f => f.kind + ':' + f.slug).sort().join(',');

/** Merge per-follow article lists: one card per slug, newest first, capped. Pure. */
export function mergeFollowedArticles(lists, limit = FEED_STORY_LIMIT) {
  const bySlug = new Map();
  for (const { follow, articles } of lists) {
    for (const article of articles || []) {
      if (!article?.slug) continue;
      const entry = bySlug.get(article.slug);
      if (entry) { if (!entry.via.some(v => v.kind === follow.kind && v.slug === follow.slug)) entry.via.push({ kind: follow.kind, slug: follow.slug, name: follow.name }); }
      else bySlug.set(article.slug, { article, via: [{ kind: follow.kind, slug: follow.slug, name: follow.name }] });
    }
  }
  const time = value => { const t = Date.parse(value || ''); return Number.isFinite(t) ? t : 0; };
  return [...bySlug.values()].sort((a, b) => time(b.article.publishedAt) - time(a.article.publishedAt) || a.article.slug.localeCompare(b.article.slug)).slice(0, limit);
}

/** The cached copy keeps card text only (no images), so it stays small. contentType keeps the Sponsored/Opinion label. */
export const slim = ({ article, via }) => ({ article: { id: article.id, slug: article.slug, title: article.title, excerpt: article.excerpt, publishedAt: article.publishedAt, category: article.category, contentType: article.contentType, bylineName: article.bylineName, featuredImage: null }, via });

const FOLLOW_KINDS = ['topic', 'author'];
/**
 * The saved copy, re-validated: every entry goes through the same normaliser as live data and invalid ones are dropped,
 * so a corrupt or hand-edited cache can never leave the section stuck or render unexpected values. Null when unusable.
 */
export function usableCachedEntries(cached, key) {
  if (!cached || typeof cached !== 'object' || cached.key !== key || !Array.isArray(cached.entries)) return null;
  const entries = [];
  for (const entry of cached.entries.slice(0, FEED_STORY_LIMIT)) {
    const raw = entry && typeof entry === 'object' && entry.article && typeof entry.article === 'object' ? entry.article : null;
    let article = null;
    try { article = raw ? normalizePublishedArticle({ ...raw, featuredImage: null, status: 'published' }) : null; } catch { article = null; }
    if (!article) continue;
    const via = Array.isArray(entry.via) ? entry.via.filter(v => v && FOLLOW_KINDS.includes(v.kind) && validTaxonomySlug(v.slug) && typeof v.name === 'string').map(v => ({ kind: v.kind, slug: v.slug, name: v.name.slice(0, 120) })) : [];
    entries.push({ article, via });
  }
  return entries;
}

export async function loadFollowingFeed({ baseUrl, follows, signal, fetchImpl = fetch }) {
  const targets = follows.slice(0, FEED_FOLLOW_LIMIT);
  const results = new Array(targets.length);
  let next = 0, failures = 0, rateLimited = false;
  async function worker() {
    while (next < targets.length) {
      const index = next++;
      const follow = targets[index];
      try {
        const item = await fetchTaxonomy({ kind: follow.kind, slug: follow.slug, baseUrl, signal, fetchImpl });
        results[index] = { follow, articles: item?.articles || [], missing: !item };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error?.status === 429) rateLimited = true;
        failures += 1;
        results[index] = { follow, articles: [], failed: true };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  return { entries: mergeFollowedArticles(results.filter(Boolean)), failures, rateLimited, total: targets.length, missing: results.filter(r => r?.missing).map(r => r.follow) };
}

export function mountFollowingFeed(api, anchor) {
  const follows = readFollows();
  if (!follows.length || !api.cmsUrl || !anchor?.isConnected) return;
  const existing = document.querySelector('#growth-following');
  existing?.remove();
  const section = document.createElement('section');
  section.id = 'growth-following';
  section.className = 'container section-list growth-following';
  section.setAttribute('aria-labelledby', 'growth-following-title');
  anchor.insertAdjacentElement('afterend', section);
  const controller = new AbortController();
  const abortOnLeave = () => controller.abort();
  addEventListener('hashchange', abortOnLeave, { once: true });
  addEventListener('popstate', abortOnLeave, { once: true });
  api.signal?.addEventListener('abort',abortOnLeave,{once:true});

  const manage = () => `<details class="growth-following-manage"><summary>Manage what you follow (${follows.length})</summary><ul>${follows.map(f => `<li><span>${escape(f.name)}</span> <small>${f.kind === 'author' ? 'Writer' : 'Topic'}</small> <button type="button" class="text-button" data-unfollow-kind="${escape(f.kind)}" data-unfollow-slug="${escape(f.slug)}">Unfollow<span class="sr-only"> ${escape(f.name)}</span></button></li>`).join('')}</ul><p class="muted small">Stored only in this browser. Clearing your browser data removes it.</p></details>`;
  let lastEntries=[],lastNote='';
  const render = (entries, note) => {
    if (!section.isConnected) return;
    lastEntries=entries;lastNote=note;
    const displayed=new Set([...document.querySelectorAll('#newsroom-home article[data-story-slug]')].map(article=>article.dataset.storySlug));
    entries=entries.filter(entry=>!displayed.has(entry.article.slug));
    section.innerHTML = `<div class="growth-following-head"><span class="eyebrow clay">FOLLOWING</span><h2 id="growth-following-title">From the topics and writers you follow.</h2></div>${note ? `<p class="growth-note" role="status">${escape(note)}</p>` : ''}${entries.length ? `<div class="story-grid">${entries.map(e => api.reportCard(e.article)).join('')}</div>` : lastEntries.length?'<p>Stories from your follows are already shown above.</p>':'<p>No published stories yet from what you follow.</p>'}${manage()}`;
    api.bindCMSImages?.(section);
    for (const button of section.querySelectorAll('[data-unfollow-kind]')) {
      button.addEventListener('click', () => {
        const follow = follows.find(f => f.kind === button.dataset.unfollowKind && f.slug === button.dataset.unfollowSlug);
        if (follow) toggleFollow(follow);
        const remaining = readFollows();
        if (!remaining.length) { section.remove(); return; }
        mountFollowingFeed(api, anchor);
        document.querySelector('#growth-following summary')?.focus();
      });
    }
  };
  document.addEventListener('ct:home-stories-changed',()=>render(lastEntries,lastNote),{signal:controller.signal});
  const key = followsKey(follows);
  const cached = readJSON(FOLLOW_FEED_CACHE_KEY, null);
  const savedEntries = usableCachedEntries(cached, key);
  const cacheUsable = Boolean(savedEntries);
  const savedNote = at => `Showing the list saved ${at ? new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'earlier'}.`;
  if (!navigator.onLine) {
    render(cacheUsable ? savedEntries : [], cacheUsable ? `You are offline. ${savedNote(cached.at)}` : 'You are offline. Stories from what you follow will appear when you reconnect.');
    addEventListener('online', () => mountFollowingFeed(api, anchor), { once: true });
    return;
  }
  section.setAttribute('aria-busy', 'true');
  section.innerHTML = '<div class="growth-following-head"><span class="eyebrow clay">FOLLOWING</span><h2 id="growth-following-title">From the topics and writers you follow.</h2></div><p role="status">Loading stories…</p>';
  if (cacheUsable) render(savedEntries, 'Updating…');
  loadFollowingFeed({ baseUrl: api.cmsUrl, follows, signal: controller.signal }).then(({ entries, failures, total, rateLimited }) => {
    section.setAttribute('aria-busy', 'false');
    if (failures === total && total) {
      render(cacheUsable ? savedEntries : [], rateLimited ? 'The newsroom is busy. Please try again in a minute.' : cacheUsable ? `We could not reach the newsroom. ${savedNote(cached.at)}` : 'We could not reach the newsroom. Please try again later.');
      return;
    }
    writeJSON(FOLLOW_FEED_CACHE_KEY, { key, at: Date.now(), entries: entries.map(slim) });
    render(entries, failures ? 'Some stories could not be loaded right now.' : follows.length > FEED_FOLLOW_LIMIT ? `Showing stories from the ${FEED_FOLLOW_LIMIT} things you followed most recently.` : '');
  }).catch(() => { section.setAttribute('aria-busy', 'false'); });
}
