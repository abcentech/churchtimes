import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveWhere, cleanFilters, groupSha, normalizeProvenance, originalDateLabel, publishBlockReason, reviewActions,
  reviewPatchBody, safeSourceUrl
} from '../src/archive-review.js';
import { can } from '../src/permissions.js';
import { MockAdapter } from '../src/api/mock.js';

const SHA = 'ab'.repeat(32);
const prov = (over = {}) => ({
  importBatch: 'arc-0123456789ab', sourceUrl: 'https://old-site.test/a/', sourceHost: 'old-site.test', sourceSha256: SHA,
  confidence: 'partial', reviewStatus: 'pending', originalDate: '2014-03-09T00:00:00.000Z', captureTimestamp: '2020-01-15T10:20:30.000Z', ...over
});
const user = (role, sections = []) => ({ id: '1', role, sections });

test('filters keep only known values and a valid batch label', () => {
  assert.deepEqual(cleanFilters({ confidence: 'partial', reviewStatus: 'pending', batch: ' arc-0123456789ab ' }),
    { confidence: 'partial', reviewStatus: 'pending', batch: 'arc-0123456789ab' });
  assert.deepEqual(cleanFilters({ confidence: 'verified-full', reviewStatus: 'x', batch: '../etc' }), { confidence: '', reviewStatus: '', batch: '' });
  assert.deepEqual(cleanFilters(), { confidence: '', reviewStatus: '', batch: '' });
});

test('the REST query always limits to imported drafts and adds each active filter', () => {
  assert.deepEqual(archiveWhere({}), [['where[provenance.importBatch][exists]', 'true']]);
  const all = Object.fromEntries(archiveWhere({ confidence: 'missing', reviewStatus: 'rejected', batch: 'b1' }));
  assert.equal(all['where[provenance.confidence][equals]'], 'missing');
  assert.equal(all['where[provenance.reviewStatus][equals]'], 'rejected');
  assert.equal(all['where[provenance.importBatch][equals]'], 'b1');
  // Count facets leave out their own filter.
  const noStatus = Object.fromEntries(archiveWhere({ confidence: 'missing', reviewStatus: 'rejected' }, 'reviewStatus'));
  assert.equal('where[provenance.reviewStatus][equals]' in noStatus, false);
  assert.equal(noStatus['where[provenance.confidence][equals]'], 'missing');
});

test('only http and https addresses become links', () => {
  assert.equal(safeSourceUrl('https://old-site.test/a/?x=1'), 'https://old-site.test/a/?x=1');
  assert.equal(safeSourceUrl('http://old-site.test/'), 'http://old-site.test/');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://old-site.test/', '/relative', '', null, undefined, 'https://user:pw@old-site.test/', 'https://' + 'a'.repeat(2100)]) {
    assert.equal(safeSourceUrl(bad), '', String(bad));
  }
});

test('provenance is read only when an import batch is present; unknown values are dropped', () => {
  assert.equal(normalizeProvenance(null), null);
  assert.equal(normalizeProvenance({ reviewStatus: 'reviewed' }), null);
  const p = normalizeProvenance(prov({ confidence: 'verified-full', reviewStatus: 'weird', sourceSha256: 'nothex' }));
  assert.equal(p.confidence, '');
  assert.equal(p.reviewStatus, 'pending');
  assert.equal(p.sourceSha256, '');
  assert.equal(normalizeProvenance(prov()).sourceSha256, SHA);
});

test('publish is blocked until reviewed, with a reason that says why', () => {
  assert.equal(publishBlockReason({ provenance: null }), '');
  assert.equal(publishBlockReason({}), '');
  assert.equal(publishBlockReason({ provenance: prov({ reviewStatus: 'reviewed' }) }), '');
  assert.match(publishBlockReason({ provenance: prov() }), /has not been reviewed yet/);
  assert.match(publishBlockReason({ provenance: prov({ reviewStatus: 'rejected' }) }), /was rejected/);
  assert.match(publishBlockReason({ provenance: prov() }), /Archive review/);
});

test('review buttons: editors see the decisions that change something, others see none', () => {
  const pending = { provenance: prov() };
  assert.deepEqual(reviewActions(pending, true), { approve: true, reject: true });
  assert.deepEqual(reviewActions({ provenance: prov({ reviewStatus: 'reviewed' }) }, true), { approve: false, reject: true });
  assert.deepEqual(reviewActions({ provenance: prov({ reviewStatus: 'rejected' }) }, true), { approve: true, reject: false });
  assert.deepEqual(reviewActions(pending, false), { approve: false, reject: false });
  assert.deepEqual(reviewActions({ provenance: null }, true), { approve: false, reject: false });
});

test('the review PATCH sends only the review status (and the version seen)', () => {
  assert.deepEqual(reviewPatchBody('reviewed', '2026-10-23T10:00:00.000Z'), { provenance: { reviewStatus: 'reviewed' }, expectedUpdatedAt: '2026-10-23T10:00:00.000Z' });
  assert.deepEqual(reviewPatchBody('rejected'), { provenance: { reviewStatus: 'rejected' } });
  assert.deepEqual(reviewPatchBody('rejected', 'not a date'), { provenance: { reviewStatus: 'rejected' } });
  assert.throws(() => reviewPatchBody('pending'));
  assert.throws(() => reviewPatchBody('published'));
});

test('labels for dates and digests', () => {
  assert.equal(originalDateLabel('2014-03-09T00:00:00.000Z'), '9 Mar 2014');
  assert.equal(originalDateLabel(null), 'Date unknown');
  assert.equal(originalDateLabel('garbage'), 'Date unknown');
  assert.equal(groupSha('abcdefgh12345678'), 'abcdefgh 12345678');
  assert.equal(groupSha(null), '');
});

test('permissions: only editors view the queue; admin, editor-in-chief and in-section editors review', () => {
  for (const role of ['admin', 'editor-in-chief', 'section-editor']) assert.equal(can(user(role, ['3']), 'archive.view'), true, role);
  for (const role of ['reporter', 'trusted-publisher']) {
    assert.equal(can(user(role, ['3']), 'archive.view'), false, role);
    assert.equal(can(user(role, ['3']), 'archive.review', { categoryId: '3' }), false, role);
  }
  assert.equal(can(user('admin'), 'archive.review', { categoryId: '9' }), true);
  assert.equal(can(user('editor-in-chief'), 'archive.review', { categoryId: '9' }), true);
  assert.equal(can(user('section-editor', ['3']), 'archive.review', { categoryId: '3' }), true);
  assert.equal(can(user('section-editor', ['3']), 'archive.review', { categoryId: '4' }), false);
  assert.equal(can(null, 'archive.view'), false);
});

// ---- the dev mock backend mirrors the CMS rules, so the screens can be driven without a server -------------------------

const mockAs = (role, sections = 'all') => {
  const api = new MockAdapter();
  api.currentUser = { id: 'u1', name: 'Test', role, sections };
  return api;
};

test('mock: lists candidates with counts and filters', async () => {
  const api = mockAs('editor-in-chief');
  const all = await api.getArchiveCandidates({});
  assert.equal(all.totalDocs, 4);
  assert.equal((await api.getArchiveCandidates({ confidence: 'missing' })).totalDocs, 1);
  assert.equal((await api.getArchiveCandidates({ batch: 'arc-fedcba987654' })).totalDocs, 1);
  const counts = await api.getArchiveCounts({});
  assert.deepEqual(counts.reviewStatus, { pending: 3, reviewed: 1, rejected: 0 });
  assert.deepEqual(counts.confidence, { partial: 2, 'citation-only': 1, missing: 1 });
  // Status counts ignore the status filter but respect the others.
  assert.deepEqual((await api.getArchiveCounts({ reviewStatus: 'reviewed', confidence: 'missing' })).reviewStatus, { pending: 1, reviewed: 0, rejected: 0 });
});

test('mock: approving needs an editor; the story stays a draft; publish is refused until reviewed', async () => {
  const reporter = mockAs('reporter', []);
  await assert.rejects(reporter.setArchiveReview('arc-1', 'reviewed'), { status: 403 });

  const eic = mockAs('editor-in-chief');
  await assert.rejects(eic.transitionArticle('arc-1', 'published'), { status: 409 });
  const approved = (await eic.setArchiveReview('arc-1', 'reviewed')).data;
  assert.equal(approved.provenance.reviewStatus, 'reviewed');
  assert.equal(approved.status, 'draft');
  assert.equal((await eic.transitionArticle('arc-1', 'published')).data.status, 'published');

  const rejected = (await eic.setArchiveReview('arc-2', 'rejected')).data;
  assert.equal(rejected.provenance.reviewStatus, 'rejected');
  assert.equal(rejected.status, 'draft');
  await assert.rejects(eic.transitionArticle('arc-2', 'published'), { status: 409 });
});

test('mock: a stale version answers 409 and a section editor outside the section is refused', async () => {
  const eic = mockAs('editor-in-chief');
  await assert.rejects(eic.setArchiveReview('arc-3', 'reviewed', { expectedUpdatedAt: '2001-01-01T00:00:00.000Z' }), { status: 409 });
  const other = mockAs('section-editor', ['not-this-section']);
  await assert.rejects(other.setArchiveReview('arc-3', 'reviewed'), { status: 403 });
});
