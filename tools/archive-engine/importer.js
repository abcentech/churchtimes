import { getPublicationConfig, isAllowedStagingHost } from './config.js';
import { htmlToLexical } from './converter.js';
import { reconcileMedia, resolveArticleMedia } from './media.js';

export async function importArticles(articles = [], options = {}) {
  const {
    publicationId = 'churchtimes',
    dryRun = true,
    stagingHost = 'localhost',
    payload = null, // Payload Local API instance (if available)
    categoriesMap = new Map(), // Title or ID -> Category record ID
    attachments = [],
    mediaDirs = [],
  } = options;

  const pubConfig = getPublicationConfig(publicationId);

  // Validate staging host against allowlist
  if (!isAllowedStagingHost(stagingHost, pubConfig)) {
    throw new Error(`Staging host "${stagingHost}" is not allowed for publication "${pubConfig.name}". Allowed: ${pubConfig.stagingAllowlist.join(', ')}`);
  }

  // Reconcile media attachments first
  const mediaReconciliation = reconcileMedia(attachments, mediaDirs);

  const importedDocs = [];
  const skippedDrafts = [];
  const duplicateReconciliations = [];
  const auditLogs = [];
  const rollbackManifest = {
    publicationId,
    timestamp: new Date().toISOString(),
    dryRun,
    createdRecordIds: [],
    processedLegacyIds: [],
  };

  const processedLegacyMap = new Map();

  for (const article of articles) {
    // 1. Exclude drafts
    const status = (article.status || 'published').toLowerCase();
    if (status === 'draft' || article.isDraft === true) {
      skippedDrafts.push({
        legacyId: article.legacyId,
        title: article.title,
        reason: 'Excluded draft status',
      });
      continue;
    }

    const legacyId = Number(article.legacyId || article.id);

    // 2. Idempotency & Duplicate Seed Reconciliation
    const idempotencyKey = `${article.source || 'wxr'}:${publicationId}:${legacyId}`;
    if (processedLegacyMap.has(idempotencyKey)) {
      duplicateReconciliations.push({
        idempotencyKey,
        legacyId,
        title: article.title,
        action: 'Skipped duplicate seed in import payload',
      });
      continue;
    }
    processedLegacyMap.set(idempotencyKey, true);

    // 3. Category Fallback with Audit Logging
    let categoryId = null;
    let usedCategoryFallback = false;

    if (article.category) {
      const catKey = String(article.category).trim();
      categoryId = categoriesMap.get(catKey) || categoriesMap.get(catKey.toLowerCase()) || null;
    }

    if (!categoryId) {
      const defaultCategoryTitle = pubConfig.defaultCategory;
      categoryId = categoriesMap.get(defaultCategoryTitle) || categoriesMap.get(defaultCategoryTitle.toLowerCase()) || 1;
      usedCategoryFallback = true;

      auditLogs.push({
        action: 'category.fallback',
        legacyId,
        publicationId,
        originalCategory: article.category || null,
        assignedCategory: defaultCategoryTitle,
        timestamp: new Date().toISOString(),
      });
    }

    // 4. Conversion to Payload Lexical AST
    const conversion = htmlToLexical(article.contentHtml || article.content || '');

    // 5. Featured Image resolution
    let featuredImageId = null;
    if (article.featuredImage) {
      const resolvedImage = resolveArticleMedia(article.featuredImage, mediaReconciliation);
      if (resolvedImage && resolvedImage.isAvailable) {
        featuredImageId = resolvedImage.attachmentId || resolvedImage.filename;
      }
    }

    // 6. Build Payload Article Data Payload
    const docData = {
      title: article.title || 'Untitled Article',
      slug: article.slug || undefined,
      excerpt: article.excerpt || '',
      content: conversion.ast,
      category: categoryId,
      featuredImage: featuredImageId,
      bylineName: article.bylineName || article.authorName || article.creator || '',
      status: 'published',
      publishedAt: article.publishedAt || article.postDate || new Date().toISOString(),
      legacyUrl: article.legacyUrl || article.link || '',
      legacyId,
      originalHtml: conversion.originalHtml,
      sha256: conversion.sha256,
    };

    let createdId = null;

    if (!dryRun && payload) {
      // Use Payload Local API to create or update
      try {
        const existing = await payload.find({
          collection: 'articles',
          where: { legacyId: { equals: legacyId } },
          limit: 1,
          overrideAccess: true,
        });

        if (existing.totalDocs > 0) {
          createdId = existing.docs[0].id;
          duplicateReconciliations.push({
            idempotencyKey,
            legacyId,
            existingId: createdId,
            action: 'Found existing article in database',
          });
        } else {
          const created = await payload.create({
            collection: 'articles',
            data: docData,
            overrideAccess: true,
            context: { seed: true },
          });
          createdId = created.id;
          rollbackManifest.createdRecordIds.push(createdId);
        }
      } catch (err) {
        auditLogs.push({
          action: 'import.error',
          legacyId,
          error: err.message,
        });
        continue;
      }
    } else {
      // Simulated/Dry-run ID
      createdId = `dryrun-${legacyId}`;
      rollbackManifest.createdRecordIds.push(createdId);
    }

    rollbackManifest.processedLegacyIds.push(legacyId);

    importedDocs.push({
      id: createdId,
      legacyId,
      title: docData.title,
      publishedAt: docData.publishedAt,
      bylineName: docData.bylineName,
      usedCategoryFallback,
      unknownBlockDetected: conversion.unknownBlockDetected,
      sha256: conversion.sha256,
    });
  }

  return {
    publicationId,
    dryRun,
    totalProcessed: articles.length,
    importedCount: importedDocs.length,
    skippedDraftsCount: skippedDrafts.length,
    duplicateCount: duplicateReconciliations.length,
    importedDocs,
    skippedDrafts,
    duplicateReconciliations,
    auditLogs,
    rollbackManifest,
    mediaReconciliation,
  };
}
