import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getPublicationConfig, isAllowedStagingHost } from '../tools/archive-engine/config.js';
import { htmlToLexical, calculateSha256 } from '../tools/archive-engine/converter.js';
import { reconcileMedia, resolveArticleMedia } from '../tools/archive-engine/media.js';
import { importArticles } from '../tools/archive-engine/importer.js';
import { generateQAReport } from '../tools/archive-engine/qa.js';

test('publication config supports multi-tenancy and staging host checks', () => {
  const ct = getPublicationConfig('churchtimes');
  assert.equal(ct.name, 'Church Times Nigeria');
  assert.equal(ct.defaultCategory, 'General News');
  assert.equal(isAllowedStagingHost('localhost:3000', ct), true);
  assert.equal(isAllowedStagingHost('staging.churchtimesnigeria.net', ct), true);
  assert.equal(isAllowedStagingHost('unauthorized.domain.com', ct), false);

  const inv = getPublicationConfig('investnaira');
  assert.equal(inv.name, 'InvestNaira');
  assert.equal(inv.defaultCategory, 'Financial Intelligence');
  assert.throws(() => getPublicationConfig('unknown'), /Unknown publication ID/);
});

test('converter parses HTML to Lexical AST and preserves SHA-256 and original HTML', () => {
  const html = '<p>Members gathered in <strong>Lagos</strong>.</p><h2>Overview</h2><ul><li>Item 1</li></ul>';
  const result = htmlToLexical(html);

  assert.equal(result.originalHtml, html);
  assert.equal(result.sha256, calculateSha256(html));
  assert.equal(result.ast.root.children.length, 3);
  assert.equal(result.ast.root.children[0].type, 'paragraph');
  assert.equal(result.ast.root.children[1].type, 'heading');
  assert.equal(result.ast.root.children[2].type, 'list');
  assert.equal(result.unknownBlockDetected, false);
});

test('converter correctly converts legacy article 20 (iframe YouTube embed)', () => {
  const iframeHtml = '<iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ" frameborder="0" allowfullscreen></iframe>';
  const result = htmlToLexical(iframeHtml);

  assert.equal(result.ast.root.children.length, 1);
  assert.equal(result.ast.root.children[0].type, 'embed');
  assert.equal(result.ast.root.children[0].embedType, 'youtube');
  assert.equal(result.ast.root.children[0].url, 'https://www.youtube.com/embed/dQw4w9WgXcQ');
});

test('converter wraps unknown HTML blocks safely without text loss', () => {
  const unknownHtml = '<custom-unsupported-widget data-id="999">Special Content</custom-unsupported-widget>';
  const result = htmlToLexical(unknownHtml);

  assert.equal(result.unknownBlockDetected, true);
  assert.equal(result.reviewFlags.includes('UNKNOWN_BLOCK_WRAP'), true);
  assert.equal(result.ast.root.children[0].children[0].text, unknownHtml);
});

test('media reconciliation identifies available binaries and flags missing files', () => {
  const fixtureDir = path.resolve('tools/archive-engine/fixtures/media');
  const attachments = [
    { id: '101', url: 'https://churchtimesnigeria.net/wp-content/uploads/2026/10/sample1.jpg', alt: 'Gathering' },
    { id: '9999', url: 'https://churchtimesnigeria.net/wp-content/uploads/2026/10/missing.jpg', alt: 'Missing' },
  ];

  const reconciliation = reconcileMedia(attachments, [fixtureDir]);

  assert.equal(reconciliation.matchedCount, 1);
  assert.equal(reconciliation.missingCount, 1);
  assert.equal(reconciliation.foundFiles[0].attachmentId, '101');
  assert.equal(reconciliation.missingFiles[0].attachmentId, '9999');

  const resolved = resolveArticleMedia({ id: '101' }, reconciliation);
  assert.equal(resolved.isAvailable, true);
  assert.equal(resolved.alt, 'Gathering');

  const resolvedMissing = resolveArticleMedia({ id: '9999' }, reconciliation);
  assert.equal(resolvedMissing.isAvailable, false);
});

test('importer executes dry-run by default, excludes drafts, and generates rollback manifest', async () => {
  const testArticles = [
    {
      legacyId: 1,
      title: 'Published Article',
      status: 'publish',
      category: 'Church Life',
      contentHtml: '<p>Content</p>',
      bylineName: 'Grace Adebayo',
      publishedAt: '2026-10-12T09:00:00Z',
    },
    {
      legacyId: 2,
      title: 'Uncategorized Article',
      status: 'publish',
      contentHtml: '<p>Content without category</p>',
    },
    {
      legacyId: 3,
      title: 'Draft Article',
      status: 'draft',
      contentHtml: '<p>Draft content</p>',
    },
    {
      legacyId: 1, // Duplicate legacyId in same import payload
      title: 'Published Article Duplicate Seed',
      status: 'publish',
      contentHtml: '<p>Duplicate</p>',
    },
  ];

  const categoriesMap = new Map([['Church Life', 10]]);

  const result = await importArticles(testArticles, {
    publicationId: 'churchtimes',
    dryRun: true,
    stagingHost: 'localhost',
    categoriesMap,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.importedCount, 2);
  assert.equal(result.skippedDraftsCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.auditLogs.length, 1); // Category fallback audit
  assert.equal(result.auditLogs[0].action, 'category.fallback');
  assert.equal(result.rollbackManifest.createdRecordIds.length, 2);
  assert.equal(result.rollbackManifest.createdRecordIds[0], 'dryrun-1');
});

test('editorial QA engine detects diffs, paragraph counts, and review queue flags', () => {
  const article = {
    legacyId: 10,
    title: 'Report Title',
    bylineName: 'Author Name',
    contentHtml: '<p>First paragraph.</p><p>Second paragraph.</p><table><tr><td>Table cell</td></tr></table>',
    featuredImage: 'image.jpg',
  };

  const conversion = htmlToLexical(article.contentHtml);
  const qaReport = generateQAReport(article, conversion, { usedCategoryFallback: true, hasFeaturedAlt: false });

  assert.equal(qaReport.sourceParagraphs, 2);
  assert.equal(qaReport.reviewFlags.includes('COMPLEX_HTML_STRUCTURE'), true);
  assert.equal(qaReport.reviewFlags.includes('CATEGORY_FALLBACK_ASSIGNED'), true);
  assert.equal(qaReport.reviewFlags.includes('MISSING_ALT_TEXT'), true);
  assert.equal(qaReport.preservesKeyAttributes, true);
  assert.equal(qaReport.requiresHumanReview, true);
});
