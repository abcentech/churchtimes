/**
 * Archive review: pure helpers for recovered archive drafts (docs: apps/cms/docs/archive-candidate-schema.md).
 *
 * An article with `provenance.importBatch` came from the archive importer. It stays a draft, and the CMS refuses to publish
 * or schedule it (409) until an editor sets `provenance.reviewStatus` to "reviewed". The provenance group is staff-only: it
 * is never part of a public response and must never be rendered on a public page. Nothing here touches the DOM.
 */

export const CONFIDENCE_LEVELS = ['partial', 'citation-only', 'missing'];
export const REVIEW_STATUSES = ['pending', 'reviewed', 'rejected'];

const CONFIDENCE_LABELS = {
  partial: 'Partial',
  'citation-only': 'Citation only',
  missing: 'Missing body'
};
const CONFIDENCE_HELP = {
  partial: 'The body was recovered but may be truncated or missing parts.',
  'citation-only': 'Only a fragment (headline, a few lines) survived.',
  missing: 'The body could not be recovered; only a note is stored.'
};
const REVIEW_LABELS = { pending: 'Pending review', reviewed: 'Reviewed', rejected: 'Rejected' };

export const confidenceLabel = c => CONFIDENCE_LABELS[c] || 'Unknown';
export const confidenceHelp = c => CONFIDENCE_HELP[c] || '';
export const reviewLabel = s => REVIEW_LABELS[s] || 'Pending review';

/** Batch labels are `arc-` plus hex, or an operator label: letters, digits, dot, underscore, hyphen; at most 80. */
export const BATCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** Keep only a valid filter value (anything else means "all"). */
export function cleanFilters(f = {}) {
  return {
    confidence: CONFIDENCE_LEVELS.includes(f.confidence) ? f.confidence : '',
    reviewStatus: REVIEW_STATUSES.includes(f.reviewStatus) ? f.reviewStatus : '',
    batch: typeof f.batch === 'string' && BATCH_RE.test(f.batch.trim()) ? f.batch.trim() : ''
  };
}

/**
 * REST `where[...]` pairs for a candidate list. `omit` drops one facet so its counts show every value
 * (the status counts ignore the status filter, the confidence counts ignore the confidence filter).
 */
export function archiveWhere(filters = {}, omit = '') {
  const f = cleanFilters(filters);
  const pairs = [['where[provenance.importBatch][exists]', 'true']];
  if (f.batch) pairs.push(['where[provenance.importBatch][equals]', f.batch]);
  if (f.confidence && omit !== 'confidence') pairs.push(['where[provenance.confidence][equals]', f.confidence]);
  if (f.reviewStatus && omit !== 'reviewStatus') pairs.push(['where[provenance.reviewStatus][equals]', f.reviewStatus]);
  return pairs;
}

/** Only an http(s) address is ever turned into a link. Anything else (javascript:, data:, relative) yields ''. */
export function safeSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return '';
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (u.username || u.password) return '';
    return u.href;
  } catch {
    return '';
  }
}

/** The staff-only provenance of one CMS article document, or null when it is not an archive candidate. */
export function normalizeProvenance(p) {
  if (!p || typeof p !== 'object') return null;
  const batch = typeof p.importBatch === 'string' ? p.importBatch : '';
  if (!batch) return null;
  const sha = typeof p.sourceSha256 === 'string' && /^[0-9a-f]{64}$/.test(p.sourceSha256) ? p.sourceSha256 : '';
  return {
    importBatch: batch,
    sourceUrl: typeof p.sourceUrl === 'string' ? p.sourceUrl : '',
    sourceHost: typeof p.sourceHost === 'string' ? p.sourceHost : '',
    captureTimestamp: p.captureTimestamp || null,
    originalDate: p.originalDate || null,
    sourceSha256: sha,
    confidence: CONFIDENCE_LEVELS.includes(p.confidence) ? p.confidence : '',
    reviewStatus: REVIEW_STATUSES.includes(p.reviewStatus) ? p.reviewStatus : 'pending'
  };
}

/**
 * Why the CMS will refuse to publish or schedule this story, or '' when nothing blocks it. Mirrors the server rule
 * (publishBlockedByProvenance): importBatch set and reviewStatus not "reviewed".
 */
export function publishBlockReason(story) {
  const p = story?.provenance;
  if (!p || !p.importBatch || p.reviewStatus === 'reviewed') return '';
  if (p.reviewStatus === 'rejected') {
    return 'This recovered archive story was rejected in archive review, so it cannot be published or scheduled. An editor must approve it in Archive review first.';
  }
  return 'This recovered archive story has not been reviewed yet, so it cannot be published or scheduled. An editor must approve it in Archive review first.';
}

/** Which review decisions the buttons offer. The CMS enforces the same rule (editors only, in their section). */
export function reviewActions(story, canReview) {
  const p = story?.provenance;
  const decided = p?.reviewStatus;
  return {
    approve: Boolean(canReview && p && decided !== 'reviewed'),
    reject: Boolean(canReview && p && decided !== 'rejected')
  };
}

/** PATCH body for a review decision (with the version the reviewer saw). Only these fields are ever sent. */
export function reviewPatchBody(reviewStatus, expectedUpdatedAt) {
  if (reviewStatus !== 'reviewed' && reviewStatus !== 'rejected') throw new Error('Unknown review decision.');
  const body = { provenance: { reviewStatus } };
  if (typeof expectedUpdatedAt === 'string' && !Number.isNaN(Date.parse(expectedUpdatedAt))) body.expectedUpdatedAt = expectedUpdatedAt;
  return body;
}

/** Short, sentence-style date for a recovered page ("12 Mar 2014"), or "Date unknown". Date-only strings stay on their day. */
export function originalDateLabel(value) {
  if (!value) return 'Date unknown';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Date unknown';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** A digest split into groups of eight so it can be compared by eye. */
export function groupSha(sha) {
  return typeof sha === 'string' ? sha.replace(/(.{8})(?=.)/g, '$1 ') : '';
}
