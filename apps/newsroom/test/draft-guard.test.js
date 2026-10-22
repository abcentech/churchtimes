import test from 'node:test';
import assert from 'node:assert/strict';
import { draftKey, saveLocalCopy, readLocalCopy, clearLocalCopy, clearAllLocalCopies, copyDiffers } from '../src/draft-guard.js';

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get length() { return m.size; },
    key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); }
  };
}
const vals = { title: 'T', slug: 's', standfirst: 'S', bylineName: 'B', bodyMd: 'Body', categoryId: '2', password: 'x', token: 'y' };

test('a saved copy round-trips and keeps only story text fields', () => {
  const st = memStorage();
  assert.equal(saveLocalCopy(st, 5, vals, { userId: 7, baseUpdatedAt: 'v1', now: 1 }), true);
  const copy = readLocalCopy(st, 5, { userId: 7 });
  assert.deepEqual(copy.values, { title: 'T', slug: 's', standfirst: 'S', bylineName: 'B', bodyMd: 'Body', categoryId: '2' });
  assert.equal(copy.baseUpdatedAt, 'v1');
  assert.ok(!st.getItem(draftKey(5)).includes('password') && !st.getItem(draftKey(5)).includes('token'));
});

test('a new (unsaved) story uses its own key', () => {
  assert.equal(draftKey(null), 'ctn_draft_new');
  assert.notEqual(draftKey(null), draftKey(1));
});

test('a copy written by another user is not offered', () => {
  const st = memStorage();
  saveLocalCopy(st, 5, vals, { userId: 7 });
  assert.equal(readLocalCopy(st, 5, { userId: 8 }), null);
});

test('clear removes one copy, clearAll removes every copy but nothing else', () => {
  const st = memStorage({ other: '1' });
  saveLocalCopy(st, 1, vals); saveLocalCopy(st, 2, vals); saveLocalCopy(st, null, vals);
  clearLocalCopy(st, 1);
  assert.equal(readLocalCopy(st, 1), null);
  assert.ok(readLocalCopy(st, 2));
  clearAllLocalCopies(st);
  assert.equal(readLocalCopy(st, 2), null);
  assert.equal(readLocalCopy(st, null), null);
  assert.equal(st.getItem('other'), '1');
});

test('corrupt data and unavailable storage never throw', () => {
  assert.equal(readLocalCopy(memStorage({ [draftKey(1)]: '{nope' }), 1), null);
  const broken = { setItem() { throw new Error('quota'); }, getItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  assert.equal(saveLocalCopy(broken, 1, vals), false);
  assert.equal(readLocalCopy(broken, 1), null);
  clearLocalCopy(broken, 1);
});

test('copyDiffers ignores surrounding whitespace only', () => {
  const base = { title: 'T', slug: 's', standfirst: 'S', bylineName: 'B', bodyMd: 'Body', categoryId: '2' };
  assert.equal(copyDiffers({ ...base, title: ' T ' }, base), false);
  assert.equal(copyDiffers({ ...base, bodyMd: 'Body more' }, base), true);
});
