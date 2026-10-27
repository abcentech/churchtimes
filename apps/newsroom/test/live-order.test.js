import test from 'node:test';
import assert from 'node:assert/strict';
import { sortPublishedNewestFirst } from '../src/live-order.js';

const ids = list => list.map(u => u.id);

test('newest published first, by publishSequence not creation sequence', () => {
  // created order A(1) B(2) C(3) R1(4) R2(5); approved order A, B, C, R2, R1
  const list = [
    { id: 'R2', sequence: 5, publishSequence: 4 },
    { id: 'R1', sequence: 4, publishSequence: 5 },
    { id: 'C', sequence: 3, publishSequence: 3 },
    { id: 'A', sequence: 1, publishSequence: 1 },
    { id: 'B', sequence: 2, publishSequence: 2 }
  ];
  assert.deepEqual(ids(sortPublishedNewestFirst(list)), ['R1', 'R2', 'C', 'B', 'A']);
});

test('rows without a publishSequence sink to the bottom and fall back to creation sequence', () => {
  const list = [
    { id: 'old', sequence: 1, publishSequence: null },
    { id: 'new', sequence: 2, publishSequence: null },
    { id: 'pub', sequence: 3, publishSequence: 1 }
  ];
  assert.deepEqual(ids(sortPublishedNewestFirst(list)), ['pub', 'new', 'old']);
});

test('does not mutate its input', () => {
  const list = [{ id: 'a', publishSequence: 1 }, { id: 'b', publishSequence: 2 }];
  sortPublishedNewestFirst(list);
  assert.deepEqual(ids(list), ['a', 'b']);
});
