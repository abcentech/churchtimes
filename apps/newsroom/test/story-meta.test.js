import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_POINTS_MAX, TOPICS_MAX, blankMeta, contentTypeOf, contentTypeLabel, isoToLocalMinutes, keyPointsFromText, localMinutesToIso,
  metaFromCms, metaProblem, metaToCms, normalizeKeyPointsText, parseIdList, profileOptions, toggleTopic
} from '../src/story-meta.js';
import { copyDiffers, readLocalCopy, saveLocalCopy } from '../src/draft-guard.js';

test('metaFromCms reads ids or populated relations and legacy rows as news', () => {
  const meta = metaFromCms({
    kicker: ' Exclusive ',
    contentType: null,
    keyPoints: [{ id: 'a', text: ' One ' }, { id: 'b', text: 'Two' }],
    lastSubstantiveUpdate: '2026-10-30T08:00:00.000Z',
    topics: [{ id: 5, name: 'X' }, 7, 5],
    bylineAuthor: { id: 9, name: 'Ada' }
  });
  assert.deepEqual(meta, {
    kicker: 'Exclusive', contentType: 'news', keyPointsText: 'One\nTwo',
    lastUpdate: '2026-10-30T08:00:00.000Z', topicIds: '5,7', bylineAuthorId: '9'
  });
  assert.deepEqual(metaFromCms({}), blankMeta());
});

test('metaToCms maps only the keys present, with CMS shapes', () => {
  assert.deepEqual(metaToCms({ title: 'x' }), {});
  assert.deepEqual(metaToCms({ kicker: '  ', contentType: 'bogus', keyPointsText: 'a\n\n b \n', lastUpdate: '', topicIds: '3,x,3,4', bylineAuthorId: '' }), {
    kicker: null, contentType: 'news', keyPoints: [{ text: 'a' }, { text: 'b' }], lastSubstantiveUpdate: null, topics: [3, 4], bylineAuthor: null
  });
  assert.deepEqual(metaToCms({ bylineAuthorId: '12', lastUpdate: '2026-10-30T08:00:00Z' }), { bylineAuthor: 12, lastSubstantiveUpdate: '2026-10-30T08:00:00.000Z' });
});

test('metaProblem mirrors the CMS limits', () => {
  assert.equal(metaProblem(blankMeta()), '');
  assert.match(metaProblem({ ...blankMeta(), kicker: 'k'.repeat(61) }), /60/);
  assert.match(metaProblem({ ...blankMeta(), kicker: '<b>x</b>' }), /plain text/);
  assert.match(metaProblem({ ...blankMeta(), keyPointsText: Array.from({ length: KEY_POINTS_MAX + 1 }, (_, i) => `p${i}`).join('\n') }), /at most 5/);
  assert.match(metaProblem({ ...blankMeta(), keyPointsText: `ok\n${'x'.repeat(201)}` }), /Key point 2/);
  const now = Date.parse('2026-10-30T08:00:00Z');
  assert.match(metaProblem({ ...blankMeta(), lastUpdate: '2026-10-31T08:00:00Z' }, now), /future/);
  assert.equal(metaProblem({ ...blankMeta(), lastUpdate: '2026-10-30T08:05:00Z' }, now), '');
});

test('topics toggle and cap', () => {
  let ids = '';
  for (let i = 1; i <= TOPICS_MAX + 2; i++) ids = toggleTopic(ids, String(i));
  assert.equal(parseIdList(ids).length, TOPICS_MAX);
  assert.equal(toggleTopic('1,2', '1'), '2');
  assert.equal(toggleTopic('1', 'x'), '1');
});

test('helpers: key point text, content type label, profile options, date round trip', () => {
  assert.deepEqual(keyPointsFromText(' a \r\n\r\nb'), ['a', 'b']);
  assert.equal(normalizeKeyPointsText('a\n\n'), 'a');
  assert.equal(contentTypeOf('factcheck'), 'factcheck');
  assert.equal(contentTypeLabel('factcheck'), 'Fact-check');
  assert.deepEqual(profileOptions([{ id: 3, name: 'Ada', isPublic: true }, { id: 4, name: 'Hidden' }, { id: 'x' }]), [
    { id: '3', label: 'Ada', hidden: false }, { id: '4', label: 'Hidden', hidden: true }
  ]);
  const iso = localMinutesToIso('2026-10-30T09:15');
  assert.equal(isoToLocalMinutes(iso), '2026-10-30T09:15');
  assert.equal(localMinutesToIso(''), '');
});

test('local safety copy keeps story details, and copies made before them stay valid', () => {
  const mem = new Map();
  const storage = { setItem: (k, v) => mem.set(k, v), getItem: k => mem.get(k) ?? null, removeItem: k => mem.delete(k) };
  saveLocalCopy(storage, '5', { title: 'T', kicker: 'K', topicIds: '1,2' });
  const copy = readLocalCopy(storage, '5');
  assert.equal(copy.values.kicker, 'K');
  assert.equal(copy.values.topicIds, '1,2');
  assert.equal('contentType' in copy.values, false);
  // An old copy (no detail keys) is compared on the text fields only.
  assert.equal(copyDiffers({ title: 'T' }, { title: 'T', contentType: 'news' }), false);
  assert.equal(copyDiffers({ title: 'T', kicker: 'K' }, { title: 'T', kicker: '' }), true);
});
