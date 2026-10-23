import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveWhere, cleanFilters, groupSha, normalizeProvenance, originalDateLabel, publishBlockReason, reviewActions,
  reviewPatchBody, safeSourceUrl, extractLinks, summarizeLinks, linksNeedAcknowledgement, isKnownLinkHost, parseKnownHosts, hostInText
} from '../src/archive-review.js';
import { markdownToHtml } from '../src/lexical.js';
import { buildCsp, cmsOrigin } from '../csp.js';
import fs from 'node:fs';
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

// ---- outbound link review ------------------------------------------------------------------------------------------

test('known hosts: exact or subdomain, case and www ignored, junk ignored', () => {
  assert.deepEqual(parseKnownHosts('Example.org, https://www.Diocese.test/path  news.test:8080'), ['example.org', 'diocese.test', 'news.test']);
  const known = ['example.org'];
  assert.equal(isKnownLinkHost('example.org', known), true);
  assert.equal(isKnownLinkHost('WWW.Example.org', known), true);
  assert.equal(isKnownLinkHost('news.example.org', known), true);
  assert.equal(isKnownLinkHost('evilexample.org', known), false);
  assert.equal(isKnownLinkHost('example.org.evil.test', known), false);
  assert.equal(isKnownLinkHost('', known), false);
  assert.equal(isKnownLinkHost('example.org', []), false);
});

test('extractLinks lists every real href, flags unknown hosts and look-alike link text', () => {
  const md = 'Read [Example](https://example.org/a), [https://example.org](https://casino.test/win?x=1&y=2) and [click](https://other.test/z). Also [mail](javascript:alert(1)).';
  const links = extractLinks(markdownToHtml(md), ['example.org']);
  assert.equal(links.length >= 3, true);
  const byHref = Object.fromEntries(links.map(l => [l.href, l]));
  assert.equal(byHref['https://example.org/a'].known, true);
  assert.equal(byHref['https://example.org/a'].mismatch, false);
  const sneaky = byHref['https://casino.test/win?x=1&y=2'];
  assert.equal(sneaky.host, 'casino.test');
  assert.equal(sneaky.known, false);
  assert.equal(sneaky.mismatch, true, 'text names example.org but the target is casino.test');
  assert.equal(byHref['https://other.test/z'].mismatch, false, 'plain words are not an address claim');
  assert.deepEqual(summarizeLinks(links).mismatched, 1);
  assert.equal(summarizeLinks(links).unknown, links.filter(l => !l.known).length);
  for (const l of links.filter(l => !l.http)) assert.equal(l.known, false);
});

test('extractLinks handles entities, nested markup and no links', () => {
  const html = '<p><a href="https://a.test/?x=1&amp;y=2" rel="noopener"><strong>Go</strong> &amp; see</a> <a href=\'https://b.test/\'>b.test</a></p>';
  const [one, two] = extractLinks(html, ['b.test']);
  assert.equal(one.href, 'https://a.test/?x=1&y=2');
  assert.equal(one.text, 'Go & see');
  assert.equal(two.known, true);
  assert.equal(two.mismatch, false);
  assert.deepEqual(extractLinks('<p>No links here</p>'), []);
  assert.equal(linksNeedAcknowledgement([]), false);
  assert.equal(linksNeedAcknowledgement(extractLinks(html)), true);
  assert.equal(hostInText('www.example.org/path'), 'example.org');
  assert.equal(hostInText('Read more'), '');
});

test('mock archive story 2 carries links so the screen can be exercised', async () => {
  const api = mockAs('editor-in-chief');
  const story = (await api.getArticle('arc-2')).data;
  const links = extractLinks(markdownToHtml(story.bodyMd), ['diocese.example']);
  assert.equal(links.length, 3);
  assert.equal(summarizeLinks(links).unknown, 2);
});

// ---- Content-Security-Policy ---------------------------------------------------------------------------------------

test('CSP: production policy is strict and names only the CMS origin', () => {
  const csp = buildCsp({ cmsUrl: 'https://cms.example.org/', dev: false });
  for (const part of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "connect-src 'self' https://cms.example.org", "img-src 'self' data: https:"]) {
    assert.ok(csp.includes(part), part);
  }
  assert.equal(/unsafe-eval|script-src[^;]*unsafe-inline|ws:|frame-ancestors/.test(csp), false);
  assert.ok(buildCsp({ cmsUrl: '' }).includes("connect-src 'self'; "), 'same-origin CMS adds nothing');
  assert.equal(cmsOrigin('javascript:alert(1)'), '');
});

test('CSP: dev policy allows the HMR socket and an http dev CMS for images', () => {
  const csp = buildCsp({ cmsUrl: 'http://localhost:3000', dev: true });
  assert.match(csp, /connect-src 'self' http:\/\/localhost:3000 ws:/);
  assert.match(csp, /img-src 'self' data: https: http:\/\/localhost:3000/);
});

test('index.html carries exactly one CSP meta with the build placeholder and no inline script', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/http-equiv="Content-Security-Policy"/g) || []).length, 1);
  assert.ok(html.includes('content="__NEWSROOM_CSP__"'));
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, 'no inline script');
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'no inline event handlers');
});
