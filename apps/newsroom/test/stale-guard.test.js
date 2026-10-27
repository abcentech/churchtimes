import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_MESSAGE, cleanExpectedUpdatedAt, isStaleConflict, liveStatusBody, transitionBody, versionMatches, withExpectedUpdatedAt
} from '../src/stale-guard.js';
import { ApiError } from '../src/api/errors.js';

const V1 = '2026-10-14T20:00:00.123Z';

test('the stale message is the exact CMS text', () => {
  assert.equal(STALE_MESSAGE, 'This item changed after you opened it. Reload and review it again.');
});

test('story actions send expectedUpdatedAt next to status and reviewNotes', () => {
  assert.deepEqual(transitionBody('approved', { expectedUpdatedAt: V1 }), { status: 'approved', expectedUpdatedAt: V1 });
  assert.deepEqual(transitionBody('published', { expectedUpdatedAt: V1 }), { status: 'published', expectedUpdatedAt: V1 });
  assert.deepEqual(
    transitionBody('changes_requested', { reviewNotes: 'Source the quote.', expectedUpdatedAt: V1 }),
    { status: 'changes_requested', reviewNotes: 'Source the quote.', expectedUpdatedAt: V1 }
  );
});

test('without a usable version the body is unchanged (old callers keep working)', () => {
  assert.deepEqual(transitionBody('in_review'), { status: 'in_review' });
  assert.deepEqual(transitionBody('approved', { expectedUpdatedAt: null }), { status: 'approved' });
  assert.deepEqual(transitionBody('approved', { expectedUpdatedAt: '' }), { status: 'approved' });
  assert.deepEqual(transitionBody('approved', { expectedUpdatedAt: 'not a date' }), { status: 'approved' });
  assert.deepEqual(transitionBody('approved', { expectedUpdatedAt: 12345 }), { status: 'approved' });
  assert.equal(cleanExpectedUpdatedAt(undefined), undefined);
  assert.equal(cleanExpectedUpdatedAt(V1), V1);
});

test('live update review actions send expectedUpdatedAt too', () => {
  assert.deepEqual(liveStatusBody('approved', { expectedUpdatedAt: V1 }), { status: 'approved', expectedUpdatedAt: V1 });
  assert.deepEqual(liveStatusBody('rejected', { expectedUpdatedAt: V1 }), { status: 'rejected', expectedUpdatedAt: V1 });
  assert.deepEqual(liveStatusBody('approved'), { status: 'approved' });
  assert.deepEqual(withExpectedUpdatedAt({ status: 'approved' }, V1), { status: 'approved', expectedUpdatedAt: V1 });
});

test('a 409 is recognised as the stale-version refusal; other errors are not', () => {
  assert.equal(isStaleConflict(new ApiError(STALE_MESSAGE, { status: 409 })), true);
  assert.equal(isStaleConflict(new ApiError('Nope', { status: 403 })), false);
  assert.equal(isStaleConflict(new ApiError('Cannot reach the CMS.', { status: 0, network: true })), false);
  assert.equal(isStaleConflict(null), false);
  assert.equal(isStaleConflict(new Error('boom')), false);
});

test('mock backend version check compares instants and is permissive without an expectation', () => {
  assert.equal(versionMatches(V1, V1), true);
  assert.equal(versionMatches(V1, '2026-10-14T20:00:00.123+00:00'), true);
  assert.equal(versionMatches(V1, '2026-10-14T20:00:00.124Z'), false);
  assert.equal(versionMatches(undefined, V1), false);
  assert.equal(versionMatches(V1, undefined), true);
  assert.equal(versionMatches(undefined, undefined), true);
});
