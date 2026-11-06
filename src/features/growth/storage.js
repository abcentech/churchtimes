// Reader-side storage for growth features. Everything stays in this browser (no account, nothing sent to the CMS).
// Every access is wrapped: private windows, blocked site data or a full quota must never break a page.
export const FOLLOW_KEY = 'ct-following';
export const RECENT_SEARCH_KEY = 'ct-recent-searches';
export const FOLLOW_FEED_CACHE_KEY = 'ct-following-feed';
export const WHATSAPP_DISMISS_KEY = 'ct-whatsapp-prompt';
export const FOLLOW_LIMIT = 50;
export const RECENT_SEARCH_LIMIT = 8;
const FOLLOW_KINDS = ['topic', 'author'];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function readJSON(key, fallback, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
export function writeJSON(key, value, storage = globalThis.localStorage) {
  try {
    if (value === null || (Array.isArray(value) && !value.length)) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

const cleanName = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
/** Follows are `{kind, slug, name}`; anything else in storage (tampered or from an older version) is dropped. */
export function normalizeFollows(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (!item || !FOLLOW_KINDS.includes(item.kind) || typeof item.slug !== 'string' || !SLUG.test(item.slug) || item.slug.length > 160) continue;
    const id = item.kind + ':' + item.slug;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: item.kind, slug: item.slug, name: cleanName(item.name) || item.slug });
    if (out.length >= FOLLOW_LIMIT) break;
  }
  return out;
}
export const readFollows = storage => normalizeFollows(readJSON(FOLLOW_KEY, [], storage));
export const isFollowing = (kind, slug, storage) => readFollows(storage).some(f => f.kind === kind && f.slug === slug);
/** Adds or removes one follow. Returns `{following, saved}`; `saved` is false when the browser refused storage. */
export function toggleFollow({ kind, slug, name }, storage) {
  const follows = readFollows(storage);
  const index = follows.findIndex(f => f.kind === kind && f.slug === slug);
  let following;
  if (index >= 0) { follows.splice(index, 1); following = false; }
  else {
    const next = normalizeFollows([{ kind, slug, name }]);
    if (!next.length) return { following: false, saved: false };
    if (follows.length >= FOLLOW_LIMIT) follows.pop();
    follows.unshift(next[0]);
    following = true;
  }
  const saved = writeJSON(FOLLOW_KEY, follows, storage);
  if (!follows.length) writeJSON(FOLLOW_FEED_CACHE_KEY, null, storage);
  return { following, saved };
}

const cleanQuery = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
export function readRecentSearches(storage) {
  const value = readJSON(RECENT_SEARCH_KEY, [], storage);
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map(cleanQuery).filter(q => q && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase())).slice(0, RECENT_SEARCH_LIMIT);
}
/** Most recent first, case-insensitive de-duplication, at most RECENT_SEARCH_LIMIT. */
export function rememberSearch(query, storage) {
  const q = cleanQuery(query);
  if (!q) return readRecentSearches(storage);
  const next = [q, ...readRecentSearches(storage).filter(item => item.toLowerCase() !== q.toLowerCase())].slice(0, RECENT_SEARCH_LIMIT);
  writeJSON(RECENT_SEARCH_KEY, next, storage);
  return next;
}
export function clearRecentSearches(storage) { writeJSON(RECENT_SEARCH_KEY, null, storage); }

export const whatsappDismissed = storage => Boolean(readJSON(WHATSAPP_DISMISS_KEY, null, storage));
