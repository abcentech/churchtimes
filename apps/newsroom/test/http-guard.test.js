import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withTimeout, RequestTimeoutError, timeoutFor, DEFAULT_TIMEOUT_MS, UPLOAD_TIMEOUT_MS,
  createConnectionState, liveStaleMessage, shouldRefreshSession, REFRESH_EVERY_MS
} from '../src/http-guard.js';
import { contentPatchBody } from '../src/stale-guard.js';

test('a request that never answers is aborted and rejects with RequestTimeoutError', async () => {
  let aborted = false;
  const hung = withTimeout(20, signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
  }));
  await assert.rejects(hung, RequestTimeoutError);
  assert.equal(aborted, true);
});

test('a fast request resolves and its timer is cleared', async () => {
  let cleared = 0;
  const v = await withTimeout(1000, async () => 42, { clearT: t => { cleared++; clearTimeout(t); } });
  assert.equal(v, 42);
  assert.equal(cleared, 1);
});

test('non-timeout errors pass through unchanged', async () => {
  const boom = new Error('boom');
  await assert.rejects(withTimeout(1000, async () => { throw boom; }), e => e === boom);
});

test('uploads get a longer timeout than ordinary calls', () => {
  assert.equal(timeoutFor({}), DEFAULT_TIMEOUT_MS);
  assert.equal(timeoutFor({ form: {} }), UPLOAD_TIMEOUT_MS);
  assert.ok(UPLOAD_TIMEOUT_MS > DEFAULT_TIMEOUT_MS);
});

test('connection state: offline on failure or browser offline, online again after a success', () => {
  const seen = [];
  const c = createConnectionState(v => seen.push(v));
  c.reportFailure();
  c.reportFailure();
  assert.equal(c.isOnline(), false);
  c.reportSuccess();
  c.setBrowserOnline(false);
  c.setBrowserOnline(true);
  assert.deepEqual(seen, [false, true, false, true]);
});

test('live stale message is empty while fresh and names the last good time when failing', () => {
  assert.equal(liveStaleMessage(Date.now(), false), '');
  assert.match(liveStaleMessage(Date.now(), true), /out of date/);
  assert.match(liveStaleMessage(null, true), /could not be loaded/);
});

test('session refresh only while the user is active and the last refresh is old enough', () => {
  const now = 10 * REFRESH_EVERY_MS;
  assert.equal(shouldRefreshSession({ now, lastActivity: now - 1000, lastRefresh: now - 1000 }), false);
  assert.equal(shouldRefreshSession({ now, lastActivity: now - 1000, lastRefresh: now - REFRESH_EVERY_MS }), true);
  assert.equal(shouldRefreshSession({ now, lastActivity: now - 2 * REFRESH_EVERY_MS, lastRefresh: now - 3 * REFRESH_EVERY_MS }), false);
});

test('content saves carry expectedUpdatedAt next to the changed fields', () => {
  const v = '2026-10-14T20:00:00.123Z';
  assert.deepEqual(contentPatchBody({ title: 'New' }, v), { title: 'New', expectedUpdatedAt: v });
  assert.deepEqual(contentPatchBody({ title: 'New' }, null), { title: 'New' });
});
