import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_TIMELINE_LIMIT, liveTimelineQueries, loadLiveTimeline, mergeLiveTimeline } from '../src/live-timeline.js';

const ids = list => list.map(u => u.id);

test('two queries: approved by -publishSequence and pending by -sequence, both capped at 100', () => {
  const q = liveTimelineQueries(7);
  assert.equal(LIVE_TIMELINE_LIMIT, 100);
  assert.deepEqual(q.approved, {
    'where[event][equals]': '7', 'where[status][equals]': 'approved', sort: '-publishSequence', limit: '100', depth: '1'
  });
  assert.deepEqual(q.pending, {
    'where[event][equals]': '7', 'where[status][equals]': 'pending', sort: '-sequence', limit: '100', depth: '1'
  });
});

test('an old update approved late stays on the timeline (top), even when 100+ newer updates exist', async () => {
  // Event with 150 updates; update #1 was created first but approved last (publishSequence 151).
  const all = [];
  for (let s = 1; s <= 150; s += 1) all.push({ id: `u${s}`, status: 'approved', sequence: s, publishSequence: s });
  all[0].publishSequence = 151;
  const calls = [];
  // A CMS stand-in that honours where/sort/limit like Payload does.
  const fetchDocs = async query => {
    calls.push(query);
    const status = query['where[status][equals]'];
    const key = query.sort.replace('-', '');
    return all.filter(u => u.status === status).sort((a, b) => b[key] - a[key]).slice(0, Number(query.limit));
  };
  const result = await loadLiveTimeline(fetchDocs, 3);
  assert.equal(calls.length, 2);
  assert.equal(result.length, 100);
  assert.equal(result[0].id, 'u1');
  assert.equal(result[1].id, 'u150');

  // The old single query (-sequence, limit 100) would have lost it:
  const old = [...all].sort((a, b) => b.sequence - a.sequence).slice(0, 100);
  assert.ok(!old.some(u => u.id === 'u1'));
});

test('approved newest-published first, then pending newest-created first; rejected ignored', () => {
  const approved = [
    { id: 'A', status: 'approved', sequence: 1, publishSequence: 2 },
    { id: 'B', status: 'approved', sequence: 2, publishSequence: 1 }
  ];
  const pending = [
    { id: 'P1', status: 'pending', sequence: 3, publishSequence: null },
    { id: 'P3', status: 'pending', sequence: 5, publishSequence: null },
    { id: 'P2', status: 'pending', sequence: 4, publishSequence: null },
    { id: 'R', status: 'rejected', sequence: 6, publishSequence: null }
  ];
  assert.deepEqual(ids(mergeLiveTimeline(approved, pending)), ['A', 'B', 'P3', 'P2', 'P1']);
});

test('de-duplicates by id and re-checks status when the CMS answered an unfiltered list', () => {
  const everything = [
    { id: 1, status: 'approved', sequence: 1, publishSequence: 1 },
    { id: 2, status: 'pending', sequence: 2, publishSequence: null },
    { id: 3, status: 'approved', sequence: 3, publishSequence: 2 }
  ];
  const merged = mergeLiveTimeline(everything, everything);
  assert.deepEqual(ids(merged), [3, 1, 2]);
  assert.deepEqual(ids(mergeLiveTimeline(undefined, null)), []);
});

test('one failing query rejects the whole load (the console shows its error banner)', async () => {
  const fetchDocs = async q => {
    if (q['where[status][equals]'] === 'pending') throw new Error('boom');
    return [];
  };
  await assert.rejects(() => loadLiveTimeline(fetchDocs, 1), /boom/);
});
