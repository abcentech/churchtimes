import fs from 'node:fs';
import path from 'node:path';

/**
 * Reconcile WXR attachments with local media binary directories.
 * Strictly checks local file existence and preserves metadata.
 * Does NOT perform external HTTP downloads.
 */
export function reconcileMedia(attachments = [], mediaDirs = []) {
  const dirs = Array.isArray(mediaDirs) ? mediaDirs : [mediaDirs];
  const reconciledMap = new Map();
  const missingFiles = [];
  const foundFiles = [];

  for (const item of attachments) {
    const attachmentId = String(item.id || item.attachmentId || '');
    const rawUrl = item.url || item.guid || '';
    const filename = path.basename(rawUrl.split('?')[0]);

    let matchedPath = null;
    let fileSize = 0;

    for (const dir of dirs) {
      if (!dir || !fs.existsSync(dir)) continue;
      const candidate = path.join(dir, filename);
      if (fs.existsSync(candidate)) {
        matchedPath = candidate;
        try {
          const stats = fs.statSync(candidate);
          fileSize = stats.size;
        } catch {
          // Ignore
        }
        break;
      }
    }

    const record = {
      attachmentId,
      originalUrl: rawUrl,
      filename,
      title: item.title || '',
      altText: item.alt || item.altText || '',
      caption: item.caption || '',
      description: item.description || '',
      width: item.width || null,
      height: item.height || null,
      matchedPath,
      fileSize,
      isAvailable: Boolean(matchedPath),
    };

    if (attachmentId) {
      reconciledMap.set(attachmentId, record);
    }
    if (filename) {
      reconciledMap.set(filename, record);
      reconciledMap.set(rawUrl, record);
    }

    if (record.isAvailable) {
      foundFiles.push(record);
    } else {
      missingFiles.push(record);
    }
  }

  return {
    reconciledMap,
    foundFiles,
    missingFiles,
    totalAttachments: attachments.length,
    matchedCount: foundFiles.length,
    missingCount: missingFiles.length,
  };
}

/**
 * Resolve featured image or inline images referenced in an article.
 */
export function resolveArticleMedia(mediaRef, reconciledResult) {
  if (!mediaRef) return null;

  const key = String(mediaRef.id || mediaRef.url || mediaRef.filename || mediaRef);
  const match = reconciledResult?.reconciledMap?.get(key);

  if (match && match.isAvailable) {
    return {
      attachmentId: match.attachmentId,
      url: match.matchedPath,
      filename: match.filename,
      alt: mediaRef.alt || match.altText || '',
      caption: mediaRef.caption || match.caption || '',
      title: match.title || '',
      width: match.width,
      height: match.height,
      isAvailable: true,
    };
  }

  return {
    attachmentId: match?.attachmentId || null,
    originalUrl: typeof mediaRef === 'string' ? mediaRef : mediaRef.url || '',
    filename: match?.filename || (typeof mediaRef === 'string' ? path.basename(mediaRef) : ''),
    alt: mediaRef.alt || match?.altText || '',
    caption: mediaRef.caption || match?.caption || '',
    isAvailable: false,
  };
}
