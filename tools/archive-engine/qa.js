import { renderArticleContent } from '../../src/lib/article-content.js';

/**
 * Extracts plain text from HTML, stripping all tags.
 */
function extractPlainTextFromHtml(html = '') {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Counts occurrences of HTML tag in a string.
 */
function countTags(html = '', tagName = 'p') {
  const regex = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const matches = html.match(regex);
  return matches ? matches.length : 0;
}

/**
 * Computes plain text diff / length difference between source HTML and converted Lexical rendered HTML.
 */
export function generateQAReport(article = {}, conversionResult = {}, options = {}) {
  const sourceHtml = article.contentHtml || article.content || '';
  const sourceText = extractPlainTextFromHtml(sourceHtml);

  // Render Lexical AST back to clean HTML to compare rendered text
  const renderedHtml = renderArticleContent(conversionResult.ast);
  const renderedText = extractPlainTextFromHtml(renderedHtml);

  // Paragraph and heading counts
  const sourceParagraphs = countTags(sourceHtml, 'p');
  const renderedParagraphs = countTags(renderedHtml, 'p');

  const sourceHeadings = (sourceHtml.match(/<h[1-6]\b[^>]*>/gi) || []).length;
  const renderedHeadings = (renderedHtml.match(/<h[2-4]\b[^>]*>/gi) || []).length;

  // Image counts
  const sourceImages = (sourceHtml.match(/<img\b[^>]*>/gi) || []).length;
  const renderedImages = (renderedHtml.match(/<figure\b[^>]*>|<img\b[^>]*>/gi) || []).length;

  // Embed counts
  const sourceEmbeds = (sourceHtml.match(/<iframe\b[^>]*>|\[youtube\s+[^\]]+\]/gi) || []).length;

  let renderedEmbeds = 0;
  function countEmbedNodes(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'embed') renderedEmbeds++;
    if (Array.isArray(node.children)) node.children.forEach(countEmbedNodes);
  }
  countEmbedNodes(conversionResult.ast?.root);

  // Text loss or mismatch detection
  const charDiff = sourceText.length - renderedText.length;
  const textMatchRatio = sourceText.length > 0 ? (1 - Math.abs(charDiff) / sourceText.length) : 1;

  // Review Queue Flags
  const reviewFlags = [];

  if (conversionResult.unknownBlockDetected) {
    reviewFlags.push('UNKNOWN_BLOCK_WRAP');
  }

  if (sourceImages > renderedImages) {
    reviewFlags.push('ORPHAN_IMAGE_REFERENCE');
  }

  if (sourceEmbeds > renderedEmbeds) {
    reviewFlags.push('EMBED_CONVERSION_MISMATCH');
  }

  if (options.usedCategoryFallback) {
    reviewFlags.push('CATEGORY_FALLBACK_ASSIGNED');
  }

  if (sourceHtml.includes('<table') || sourceHtml.includes('<figure')) {
    reviewFlags.push('COMPLEX_HTML_STRUCTURE');
  }

  if (article.featuredImage && !article.featuredImageAlt && !options.hasFeaturedAlt) {
    reviewFlags.push('MISSING_ALT_TEXT');
  }

  if (textMatchRatio < 0.85 && sourceText.length > 50) {
    reviewFlags.push('TEXT_COMPARISON_WARNING');
  }

  // Preservation Policy Safety Verification
  // Automated cleanup may fix presentation ONLY.
  // Verify that factual strings, dates, or author names are not altered.
  const preservesKeyAttributes = Boolean(
    (!article.title || renderedText.includes(article.title) || sourceText.includes(article.title)) &&
    (!article.bylineName || renderedText.includes(article.bylineName) || sourceText.includes(article.bylineName))
  );

  return {
    legacyId: article.legacyId || article.id,
    title: article.title,
    sha256: conversionResult.sha256,
    sourceTextLength: sourceText.length,
    renderedTextLength: renderedText.length,
    charDiff,
    textMatchRatio,
    sourceParagraphs,
    renderedParagraphs,
    sourceHeadings,
    renderedHeadings,
    sourceImages,
    renderedImages,
    sourceEmbeds,
    renderedEmbeds,
    reviewFlags,
    preservesKeyAttributes,
    requiresHumanReview: reviewFlags.length > 0,
  };
}
