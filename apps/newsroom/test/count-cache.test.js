import test from 'node:test';
import assert from 'node:assert/strict';
import { createCountCache } from '../src/api/count-cache.js';

function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('concurrent callers share one in-flight load', async () => {
  const cache = createCountCache();
  let calls = 0;
  const gate = deferred();
  const load = () => { calls += 1; return gate.promise; };
  const a = cache.get(load);
  const b = cache.get(load);
  gate.resolve({ draft: 3 });
  assert.deepEqual(await a, { draft: 3 });
  assert.deepEqual(await b, { draft: 3 });
  assert.equal(calls, 1);
});

test('a settled result is reused inside the TTL and reloaded after it', async () => {
  const c = clock();
  const cache = createCountCache({ ttlMs: 15000, now: c.now });
  let calls = 0;
  const load = async () => { calls += 1; return { draft: calls }; };
  assert.deepEqual(await cache.get(load), { draft: 1 });
  c.advance(14999);
  assert.deepEqual(await cache.get(load), { draft: 1 });
  assert.equal(calls, 1);
  c.advance(2);
  assert.deepEqual(await cache.get(load), { draft: 2 });
  assert.equal(calls, 2);
});

test('invalidate() forces the next call to query the server again', async () => {
  const cache = createCountCache();
  let calls = 0;
  const load = async () => { calls += 1; return { published: calls }; };
  await cache.get(load);
  cache.invalidate();
  assert.deepEqual(await cache.get(load), { published: 2 });
  assert.equal(calls, 2);
});

test('a load that was in flight when invalidate() ran is not reused by later callers', async () => {
  const cache = createCountCache();
  const first = deferred();
  let calls = 0;
  const pending = cache.get(() => { calls += 1; return first.promise; });
  cache.invalidate(); // the user saved a story while the counts were still loading
  const fresh = cache.get(async () => { calls += 1; return { draft: 'after-write' }; });
  first.resolve({ draft: 'before-write' });
  assert.deepEqual(await pending, { draft: 'before-write' }); // the caller that asked earlier keeps its answer
  assert.deepEqual(await fresh, { draft: 'after-write' });
  assert.equal(calls, 2);
});

test('a failed load is not cached: the next call retries', async () => {
  const cache = createCountCache();
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (calls === 1) throw new Error('network down');
    return { draft: 1 };
  };
  await assert.rejects(cache.get(load), /network down/);
  assert.deepEqual(await cache.get(load), { draft: 1 });
  assert.equal(calls, 2);
});

test('an expired entry is replaced; a failed replacement rejects the callers who joined it', async () => {
  const c = clock();
  const cache = createCountCache({ ttlMs: 1000, now: c.now });
  await cache.get(async () => ({ v: 1 }));
  c.advance(1001);
  const stale = deferred();
  const p = cache.get(() => stale.promise); // a fresh load is now the current entry
  const other = cache.get(async () => ({ v: 'never' })); // joins the in-flight load
  stale.reject(new Error('boom'));
  await assert.rejects(p, /boom/);
  await assert.rejects(other, /boom/);
  assert.deepEqual(await cache.get(async () => ({ v: 3 })), { v: 3 });
});

test('a failure of an invalidated load does not wipe the newer entry that replaced it', async () => {
  const cache = createCountCache();
  const old = deferred();
  const oldPromise = cache.get(() => old.promise);
  cache.invalidate();
  const current = deferred();
  const newPromise = cache.get(() => current.promise);
  old.reject(new Error('old failed'));
  await assert.rejects(oldPromise, /old failed/);
  let calls = 0;
  const joined = cache.get(async () => { calls += 1; return { draft: 9 }; });
  current.resolve({ draft: 7 });
  assert.deepEqual(await newPromise, { draft: 7 });
  assert.deepEqual(await joined, { draft: 7 }); // joined the newer in-flight load, no second request
  assert.equal(calls, 0);
});
