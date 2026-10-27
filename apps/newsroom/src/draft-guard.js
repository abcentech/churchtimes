/**
 * Local safety copy of an editor's unsaved text (sessionStorage, per tab, cleared when the tab closes).
 * Holds ONLY story text fields plus the user id and the server version it was based on. Never credentials or tokens.
 * Pure functions: the storage object is injected so they run in plain Node.
 */

const PREFIX = 'ctn_draft_';
const FIELDS = ['title', 'slug', 'standfirst', 'bylineName', 'bodyMd', 'categoryId', 'extraCategoryIds'];

export const draftKey = storyId => `${PREFIX}${storyId ? String(storyId) : 'new'}`;

function pick(values) {
  const out = {};
  for (const f of FIELDS) out[f] = String(values?.[f] ?? '');
  return out;
}

/** Store the copy. Returns false when storage is unavailable or full (never throws). */
export function saveLocalCopy(storage, storyId, values, { userId = null, baseUpdatedAt = null, now = Date.now() } = {}) {
  try {
    storage.setItem(draftKey(storyId), JSON.stringify({
      v: 1, userId: userId === null ? null : String(userId), baseUpdatedAt, savedAt: now, values: pick(values)
    }));
    return true;
  } catch { return false; }
}

/** The stored copy, or null when absent, corrupt, or belonging to another user. */
export function readLocalCopy(storage, storyId, { userId = null } = {}) {
  try {
    const raw = storage.getItem(draftKey(storyId));
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || c.v !== 1 || typeof c.values !== 'object' || c.values === null) return null;
    if (userId !== null && c.userId !== String(userId)) return null;
    return { ...c, values: pick(c.values) };
  } catch { return null; }
}

export function clearLocalCopy(storage, storyId) {
  try { storage.removeItem(draftKey(storyId)); } catch { /* ignore */ }
}

/** Logout: remove every local copy. */
export function clearAllLocalCopies(storage) {
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach(k => storage.removeItem(k));
  } catch { /* ignore */ }
}

/** True when the copy holds text that differs from the given baseline fields. */
export function copyDiffers(copyValues, baseline) {
  return FIELDS.some(f => String(copyValues?.[f] ?? '').trim() !== String(baseline?.[f] ?? '').trim());
}
