import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EXTRA_CATEGORIES, parseIds, cleanExtraIds, toggleExtra, extraIdsFromCms, extraIdsToCms, categoryFieldsToCms } from '../src/categories.js';

test('parseIds keeps distinct numeric ids only', () => {
  assert.deepEqual(parseIds('3, 5,3,x,,7'), ['3', '5', '7']);
  assert.deepEqual(parseIds(null), []);
});

test('the primary is never an extra, and the extras are capped at five', () => {
  assert.equal(cleanExtraIds('3', '3,4,5'), '4,5');
  assert.equal(MAX_EXTRA_CATEGORIES, 5);
  assert.equal(cleanExtraIds('1', '2,3,4,5,6,7,8'), '2,3,4,5,6');
});

test('toggle adds, removes, refuses the primary and refuses a sixth', () => {
  let v = '';
  v = toggleExtra('1', v, 2); assert.equal(v, '2');
  v = toggleExtra('1', v, 1); assert.equal(v, '2');
  v = toggleExtra('1', v, 2); assert.equal(v, '');
  for (const id of [2, 3, 4, 5, 6, 7]) v = toggleExtra('1', v, id);
  assert.equal(v, '2,3,4,5,6');
});

test('CMS values map both ways', () => {
  assert.equal(extraIdsFromCms([4, { id: 5, title: 'X' }, null]), '4,5');
  assert.equal(extraIdsFromCms(undefined), '');
  assert.deepEqual(extraIdsToCms('4', '4,5,6'), [5, 6]);
});

test('the CMS write carries categories as numeric ids without the primary', () => {
  const out = categoryFieldsToCms({ categoryId: '4', extraCategoryIds: '4,5,6' });
  assert.equal(out.category, 4);
  assert.deepEqual(out.categories, [5, 6]);
  assert.deepEqual(categoryFieldsToCms({ extraCategoryIds: '' }), { categories: [] });
  assert.deepEqual(categoryFieldsToCms({ title: 'x' }), {});
});
