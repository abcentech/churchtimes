/**
 * Additional (secondary) categories of a story. The CMS keeps `category` as the PRIMARY section (one, required) and
 * `categories` as an optional list of extra sections: at most 5, no duplicates, never the primary one.
 * In the editor the extras travel as a comma-joined string of ids (like every other form value), so a change is a plain
 * string comparison. Pure functions, unit tested in plain Node.
 */

export const MAX_EXTRA_CATEGORIES = 5;

/** '3,5' -> ['3','5'] (numeric ids only, distinct, in order). */
export function parseIds(value) {
  const out = [];
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  for (const v of raw) {
    const s = String(v ?? '').trim();
    if (/^\d{1,15}$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The extras to keep next to this primary: distinct, never the primary, at most MAX_EXTRA_CATEGORIES. Returns the joined string. */
export function cleanExtraIds(primaryId, extras) {
  const primary = String(primaryId ?? '').trim();
  return parseIds(extras).filter(id => id !== primary).slice(0, MAX_EXTRA_CATEGORIES).join(',');
}

/** Toggle one id in the extras. Adding is refused (unchanged) for the primary or when the cap is reached. */
export function toggleExtra(primaryId, extras, id) {
  const ids = parseIds(extras);
  const s = String(id);
  if (ids.includes(s)) return cleanExtraIds(primaryId, ids.filter(x => x !== s));
  if (s === String(primaryId) || ids.length >= MAX_EXTRA_CATEGORIES) return cleanExtraIds(primaryId, ids);
  return cleanExtraIds(primaryId, [...ids, s]);
}

/** Ids of a CMS `categories` value (ids or populated objects) as the joined string. */
export function extraIdsFromCms(value) {
  if (!Array.isArray(value)) return '';
  return parseIds(value.map(v => (v && typeof v === 'object' ? v.id : v))).join(',');
}

/** The CMS `categories` payload (numbers) for the joined string, with the primary removed. */
export function extraIdsToCms(primaryId, extras) {
  return parseIds(cleanExtraIds(primaryId, extras)).map(Number);
}

/**
 * The category part of a CMS write: `category` (primary) and `categories` (extras, only when the editor sent them; an
 * empty string clears them). `toId` validates an id (throws on a bad one).
 */
export function categoryFieldsToCms(fields, toId = Number) {
  const out = {};
  if ('categoryId' in fields && fields.categoryId) out.category = toId(fields.categoryId);
  if ('extraCategoryIds' in fields) {
    const primary = 'categoryId' in fields ? fields.categoryId : '';
    out.categories = extraIdsToCms(primary, fields.extraCategoryIds).map(toId);
  }
  return out;
}
