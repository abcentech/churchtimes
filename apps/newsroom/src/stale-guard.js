/**
 * "Approve what you saw": every approve / publish / request-changes (and reject) action sends the `updatedAt` of the
 * version the editor was looking at as `expectedUpdatedAt`. The CMS answers 409 when the item changed since, and the
 * newsroom then shows this message and reloads the item. Pure helpers, unit-testable in plain Node.
 */

export const STALE_MESSAGE = 'This item changed after you opened it. Reload and review it again.';

/** A usable `expectedUpdatedAt`: a non-empty string that parses as a date. Anything else is not sent. */
export function cleanExpectedUpdatedAt(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

/** Add `expectedUpdatedAt` to a PATCH body when the caller supplied a usable one. Returns the same object. */
export function withExpectedUpdatedAt(body, expectedUpdatedAt) {
  const v = cleanExpectedUpdatedAt(expectedUpdatedAt);
  if (v !== undefined) body.expectedUpdatedAt = v;
  return body;
}

/** The PATCH body of a story workflow action (status, optional editor notes, optional expected version). */
export function transitionBody(status, { reviewNotes, expectedUpdatedAt } = {}) {
  const body = { status };
  if (reviewNotes !== undefined) body.reviewNotes = reviewNotes;
  return withExpectedUpdatedAt(body, expectedUpdatedAt);
}

/** The PATCH body of a live-update review action. */
export function liveStatusBody(status, { expectedUpdatedAt } = {}) {
  return withExpectedUpdatedAt({ status }, expectedUpdatedAt);
}

/** True for the CMS "this item changed" refusal (HTTP 409 on a workflow PATCH). */
export function isStaleConflict(err) {
  return Boolean(err) && err.status === 409;
}

/** Mock backend: does the stored version still match what the editor saw? (no expectation => always) */
export function versionMatches(currentUpdatedAt, expectedUpdatedAt) {
  const expected = cleanExpectedUpdatedAt(expectedUpdatedAt);
  if (expected === undefined) return true;
  const current = Date.parse(currentUpdatedAt || '');
  return !Number.isNaN(current) && current === Date.parse(expected);
}

/** Content-save (PATCH) body: the allowlisted CMS fields plus the version the editor loaded, so a concurrent edit answers 409. */
export function contentPatchBody(cmsFields, expectedUpdatedAt) {
  return withExpectedUpdatedAt({ ...cmsFields }, expectedUpdatedAt);
}

export const CONTENT_CONFLICT_MESSAGE = 'This story was changed by someone else after you opened it. Your text is still here and has not been saved. Copy it, then reload the story to see the latest version.';
