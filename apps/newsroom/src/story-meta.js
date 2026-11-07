/**
 * Waves 1-2 story details (apps/cms/docs/w12/schema-contract.md section 1): kicker, story type, key points, the editor-set
 * "Updated" stamp, topics and the public byline profile. In the editor every value travels as a plain string (like the
 * other form values) so a change is a string comparison; these pure functions convert to and from the CMS shapes.
 * The CMS enforces every rule (400 with its message); the checks here only give the writer the message earlier.
 */

export const KICKER_MAX = 60;
export const KEY_POINTS_MAX = 5;
export const KEY_POINT_MAX = 200;
export const TOPICS_MAX = 10;
export const UPDATE_FUTURE_SKEW_MS = 10 * 60 * 1000;

export const CONTENT_TYPES = [
  { value: 'news', label: 'News' },
  { value: 'analysis', label: 'Analysis' },
  { value: 'opinion', label: 'Opinion' },
  { value: 'sponsored', label: 'Sponsored' },
  { value: 'explainer', label: 'Explainer' },
  { value: 'factcheck', label: 'Fact-check' }
];
const TYPE_VALUES = CONTENT_TYPES.map(t => t.value);

export const contentTypeOf = value => (TYPE_VALUES.includes(value) ? value : 'news');
export const contentTypeLabel = value => CONTENT_TYPES.find(t => t.value === contentTypeOf(value)).label;

/** Form keys owned by this module (also the keys of `metaFromCms`). */
export const META_KEYS = ['kicker', 'contentType', 'keyPointsText', 'lastUpdate', 'topicIds', 'bylineAuthorId'];

const ID_RE = /^[1-9]\d{0,9}$/;
const relId = v => (v && typeof v === 'object' ? v.id : v);

/** '3,5' -> ['3','5']: positive integer ids only, distinct, in order. */
export function parseIdList(value) {
  const out = [];
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  for (const v of raw) {
    const s = String(relId(v) ?? '').trim();
    if (ID_RE.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** One key point per line; blank lines dropped; each trimmed. */
export function keyPointsFromText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
}

/** Canonical text form (so a stray space or blank line is never an edit). */
export const normalizeKeyPointsText = text => keyPointsFromText(text).join('\n');

/** An ISO date as the canonical comparison string ('' when unset or invalid). */
export function normalizeIso(value) {
  if (!value) return '';
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

/** The story-detail form values of a CMS article document (ids or populated relationships). */
export function metaFromCms(doc = {}) {
  return {
    kicker: typeof doc.kicker === 'string' ? doc.kicker.trim() : '',
    contentType: contentTypeOf(doc.contentType),
    keyPointsText: normalizeKeyPointsText((Array.isArray(doc.keyPoints) ? doc.keyPoints : []).map(k => k?.text ?? '').join('\n')),
    lastUpdate: normalizeIso(doc.lastSubstantiveUpdate),
    topicIds: parseIdList(Array.isArray(doc.topics) ? doc.topics : []).join(','),
    bylineAuthorId: parseIdList([doc.bylineAuthor])[0] || ''
  };
}

/** Story-detail defaults of a new story. */
export const blankMeta = () => ({ kicker: '', contentType: 'news', keyPointsText: '', lastUpdate: '', topicIds: '', bylineAuthorId: '' });

/** The CMS write for the story-detail keys present in `fields` (others untouched). */
export function metaToCms(fields) {
  const out = {};
  if ('kicker' in fields) out.kicker = String(fields.kicker ?? '').trim() || null;
  if ('contentType' in fields) out.contentType = contentTypeOf(fields.contentType);
  if ('keyPointsText' in fields) out.keyPoints = keyPointsFromText(fields.keyPointsText).map(text => ({ text }));
  if ('lastUpdate' in fields) out.lastSubstantiveUpdate = normalizeIso(fields.lastUpdate) || null;
  if ('topicIds' in fields) out.topics = parseIdList(fields.topicIds).map(Number);
  if ('bylineAuthorId' in fields) {
    const id = parseIdList([fields.bylineAuthorId])[0];
    out.bylineAuthor = id ? Number(id) : null;
  }
  return out;
}

/** A message for the first problem in the story-detail values, or '' (mirrors the CMS limits). */
export function metaProblem(values, now = Date.now()) {
  const kicker = String(values.kicker ?? '').trim();
  if (kicker.length > KICKER_MAX) return `The kicker can be at most ${KICKER_MAX} characters.`;
  if (/[<>]/.test(kicker)) return 'The kicker must be plain text (no < or >).';
  const points = keyPointsFromText(values.keyPointsText);
  if (points.length > KEY_POINTS_MAX) return `Use at most ${KEY_POINTS_MAX} key points (one per line).`;
  const long = points.findIndex(p => p.length > KEY_POINT_MAX);
  if (long >= 0) return `Key point ${long + 1} is longer than ${KEY_POINT_MAX} characters.`;
  if (points.some(p => /[<>]/.test(p))) return 'Key points must be plain text (no < or >).';
  if (parseIdList(values.topicIds).length > TOPICS_MAX) return `Choose at most ${TOPICS_MAX} topics.`;
  const stamp = values.lastUpdate ? Date.parse(values.lastUpdate) : NaN;
  if (values.lastUpdate && !Number.isFinite(stamp)) return 'The "Updated" date is not a valid date.';
  if (Number.isFinite(stamp) && stamp > now + UPDATE_FUTURE_SKEW_MS) return 'The "Updated" date cannot be in the future.';
  return '';
}

/** Toggle one topic id; adding is refused (unchanged) at the cap. Returns the joined string. */
export function toggleTopic(ids, id) {
  const list = parseIdList(ids);
  const s = String(id);
  if (list.includes(s)) return list.filter(x => x !== s).join(',');
  if (!ID_RE.test(s) || list.length >= TOPICS_MAX) return list.join(',');
  return [...list, s].join(',');
}

/** `datetime-local` input value (local time, minutes) for an ISO string, '' when unset. */
export function isoToLocalMinutes(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO string for a `datetime-local` value (interpreted in the browser's time zone), '' when empty or invalid. */
export function localMinutesToIso(value) {
  if (!value) return '';
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

/** Topic / author profile option lists from CMS docs: [{ id, label, hidden }]. Staff see non-public ones (marked). */
export function profileOptions(docs, nameKey = 'name') {
  return (Array.isArray(docs) ? docs : [])
    .filter(d => d && ID_RE.test(String(d.id)))
    .map(d => ({ id: String(d.id), label: String(d[nameKey] || d.slug || `#${d.id}`), hidden: d.isPublic !== true }));
}
