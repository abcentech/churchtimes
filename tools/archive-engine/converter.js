import crypto from 'node:crypto';

/**
 * Calculates SHA-256 hash of a string.
 */
export function calculateSha256(content) {
  return crypto.createHash('sha256').update(content || '').digest('hex');
}

/**
 * Clean and normalize inline text, stripping tags if necessary.
 */
function cleanText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Parse inline formatting tags (<strong>, <em>, <a>, <code>, <u>, <s>, etc.) into Lexical text/link nodes.
 */
function parseInlineContent(html) {
  if (!html) return [];

  const nodes = [];
  // Tokenize inline tags and plain text
  const regex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>|<(strong|b)>(.*?)<\/\3>|<(em|i)>(.*?)<\/\5>|<(u)>(.*?)<\/\7>|<(s|del|strike)>(.*?)<\/\9>|<code>(.*?)<\/code>/gi;

  let lastIndex = 0;
  let match;

  while ((match = regex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      const text = cleanText(html.slice(lastIndex, match.index));
      if (text) {
        nodes.push({ type: 'text', text, format: 0, detail: 0, mode: 'normal', style: '', version: 1 });
      }
    }

    if (match[1] !== undefined) {
      // <a> tag
      const href = match[1];
      const linkText = cleanText(match[2]);
      nodes.push({
        type: 'link',
        fields: { url: href, newTab: false },
        children: [{ type: 'text', text: linkText || href, format: 0, detail: 0, mode: 'normal', style: '', version: 1 }],
      });
    } else if (match[3] !== undefined) {
      // strong / b
      const text = cleanText(match[4]);
      if (text) nodes.push({ type: 'text', text, format: 1, detail: 0, mode: 'normal', style: '', version: 1 });
    } else if (match[5] !== undefined) {
      // em / i
      const text = cleanText(match[6]);
      if (text) nodes.push({ type: 'text', text, format: 2, detail: 0, mode: 'normal', style: '', version: 1 });
    } else if (match[7] !== undefined) {
      // u
      const text = cleanText(match[8]);
      if (text) nodes.push({ type: 'text', text, format: 8, detail: 0, mode: 'normal', style: '', version: 1 });
    } else if (match[9] !== undefined) {
      // s / del / strike
      const text = cleanText(match[10]);
      if (text) nodes.push({ type: 'text', text, format: 4, detail: 0, mode: 'normal', style: '', version: 1 });
    } else if (match[11] !== undefined) {
      // code
      const text = cleanText(match[11]);
      if (text) nodes.push({ type: 'text', text, format: 16, detail: 0, mode: 'normal', style: '', version: 1 });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < html.length) {
    const text = cleanText(html.slice(lastIndex));
    if (text) {
      nodes.push({ type: 'text', text, format: 0, detail: 0, mode: 'normal', style: '', version: 1 });
    }
  }

  return nodes.length > 0 ? nodes : [{ type: 'text', text: cleanText(html), format: 0, detail: 0, mode: 'normal', style: '', version: 1 }];
}

/**
 * Extracts YouTube or video embed URL from iframe or shortcode.
 */
function extractEmbedUrl(html) {
  // Check iframe src
  const iframeMatch = html.match(/<iframe\s+[^>]*src=["']([^"']+)["']/i);
  if (iframeMatch) return iframeMatch[1];

  // Check YouTube shortcode e.g. [youtube https://www.youtube.com/watch?v=... ] or [youtube v=...]
  const ytMatch = html.match(/\[youtube\s+(?:https?:\/\/)?([^\s\]]+)\]/i);
  if (ytMatch) {
    const target = ytMatch[1];
    return target.startsWith('http') ? target : `https://www.youtube.com/watch?v=${target}`;
  }

  return null;
}

/**
 * Converts WordPress HTML/Gutenberg string to Payload 3.90.2 Lexical AST.
 */
export function htmlToLexical(rawHtml) {
  const originalHtml = rawHtml || '';
  const sha256 = calculateSha256(originalHtml);
  let unknownBlockDetected = false;
  const reviewFlags = [];

  const children = [];

  if (!originalHtml.trim()) {
    return {
      ast: {
        root: {
          type: 'root',
          format: '',
          indent: 0,
          version: 1,
          direction: 'ltr',
          children: [],
        },
      },
      originalHtml,
      sha256,
      unknownBlockDetected: false,
      reviewFlags: [],
    };
  }

  // Pre-process: split into block-level chunks
  // Handles Gutenberg comment blocks, headings, paragraphs, lists, quotes, tables, figures, iframes, shortcodes
  const blockRegex = /<!--\s*wp:(?:[a-z0-9\/-]+)\s*({.*?})?\s*-->([\s\S]*?)<!--\s*\/wp:(?:[a-z0-9\/-]+)\s*-->|<h([1-6])\b[^>]*>([\s\S]*?)<\/h\3>|<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>|<(ul|ol)\b[^>]*>([\s\S]*?)<\/\6>|<table\b[^>]*>([\s\S]*?)<\/table>|<figure\b[^>]*>([\s\S]*?)<\/figure>|<iframe\b[^>]*>([\s\S]*?)<\/iframe>|\[youtube\s+[^\]]+\]|<p\b[^>]*>([\s\S]*?)<\/p>/gi;

  let lastIndex = 0;
  let match;
  let matchedBlocks = 0;

  while ((match = blockRegex.exec(originalHtml)) !== null) {
    // Check if there was unparsed text between blocks
    if (match.index > lastIndex) {
      const leftover = originalHtml.slice(lastIndex, match.index).trim();
      if (leftover && !leftover.startsWith('<!--')) {
        // Handle unparsed paragraph text
        const paras = leftover.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
        for (const pText of paras) {
          children.push({
            type: 'paragraph',
            format: '',
            indent: 0,
            version: 1,
            direction: 'ltr',
            children: parseInlineContent(pText),
          });
        }
      }
    }

    matchedBlocks++;

    if (match[0].startsWith('<!--')) {
      // Gutenberg block
      const blockContent = match[2];
      const embedUrl = extractEmbedUrl(blockContent);
      if (embedUrl) {
        children.push({
          type: 'embed',
          embedType: embedUrl.includes('youtube') || embedUrl.includes('youtu.be') ? 'youtube' : 'iframe',
          url: embedUrl,
          version: 1,
        });
      } else {
        const inline = parseInlineContent(blockContent);
        if (inline.length > 0) {
          children.push({
            type: 'paragraph',
            format: '',
            indent: 0,
            version: 1,
            direction: 'ltr',
            children: inline,
          });
        }
      }
    } else if (match[3] !== undefined) {
      // Heading h1-h6
      const tag = `h${match[3]}`;
      const headingText = match[4];
      children.push({
        type: 'heading',
        tag,
        format: '',
        indent: 0,
        version: 1,
        direction: 'ltr',
        children: parseInlineContent(headingText),
      });
    } else if (match[5] !== undefined) {
      // Blockquote
      const quoteText = match[5];
      children.push({
        type: 'quote',
        format: '',
        indent: 0,
        version: 1,
        direction: 'ltr',
        children: parseInlineContent(quoteText),
      });
    } else if (match[6] !== undefined) {
      // List (ul / ol)
      const listType = match[6].toLowerCase() === 'ol' ? 'number' : 'bullet';
      const listContent = match[7];
      const itemRegex = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
      const items = [];
      let itemMatch;
      let itemIdx = 1;
      while ((itemMatch = itemRegex.exec(listContent)) !== null) {
        items.push({
          type: 'listitem',
          value: itemIdx++,
          format: '',
          indent: 0,
          version: 1,
          direction: 'ltr',
          children: parseInlineContent(itemMatch[1]),
        });
      }
      if (items.length > 0) {
        children.push({
          type: 'list',
          listType,
          format: '',
          indent: 0,
          version: 1,
          direction: 'ltr',
          children: items,
        });
      }
    } else if (match[8] !== undefined) {
      // Table
      const tableHtml = match[8];
      const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      const rows = [];
      let rowMatch;
      while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
        const cellRegex = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
        const cells = [];
        let cellMatch;
        while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
          cells.push({
            type: 'tablecell',
            version: 1,
            children: parseInlineContent(cellMatch[1]),
          });
        }
        if (cells.length > 0) {
          rows.push({
            type: 'tablerow',
            version: 1,
            children: cells,
          });
        }
      }
      if (rows.length > 0) {
        children.push({
          type: 'table',
          version: 1,
          children: rows,
        });
      }
    } else if (match[9] !== undefined) {
      // Figure / Caption / Image
      const figHtml = match[9];
      const imgMatch = figHtml.match(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/i);
      const captionMatch = figHtml.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
      const altMatch = figHtml.match(/alt=["']([^"']*)["']/i);

      if (imgMatch) {
        children.push({
          type: 'upload',
          relationTo: 'media',
          value: imgMatch[1],
          fields: {
            alt: altMatch ? altMatch[1] : '',
            caption: captionMatch ? cleanText(captionMatch[1]) : '',
          },
          version: 1,
        });
      } else {
        const inline = parseInlineContent(figHtml);
        if (inline.length > 0) {
          children.push({
            type: 'paragraph',
            format: '',
            indent: 0,
            version: 1,
            direction: 'ltr',
            children: inline,
          });
        }
      }
    } else if (match[10] !== undefined || match[0].startsWith('[youtube')) {
      // Embed iframe or YouTube shortcode (e.g. Legacy Article 20)
      const embedUrl = extractEmbedUrl(match[0]);
      if (embedUrl) {
        children.push({
          type: 'embed',
          embedType: embedUrl.includes('youtube') || embedUrl.includes('youtu.be') ? 'youtube' : 'iframe',
          url: embedUrl,
          version: 1,
        });
      }
    } else if (match[11] !== undefined) {
      // Paragraph <p>
      const pText = match[11];
      const embedUrl = extractEmbedUrl(pText);
      if (embedUrl && cleanText(pText).trim().length < embedUrl.length + 20) {
        children.push({
          type: 'embed',
          embedType: embedUrl.includes('youtube') || embedUrl.includes('youtu.be') ? 'youtube' : 'iframe',
          url: embedUrl,
          version: 1,
        });
      } else {
        const inline = parseInlineContent(pText);
        if (inline.length > 0) {
          children.push({
            type: 'paragraph',
            format: '',
            indent: 0,
            version: 1,
            direction: 'ltr',
            children: inline,
          });
        }
      }
    }

    lastIndex = blockRegex.lastIndex;
  }

  // Handle trailing text or unformatted raw HTML if blockRegex didn't match anything
  if (matchedBlocks === 0 && originalHtml.trim()) {
    const embedUrl = extractEmbedUrl(originalHtml);
    if (embedUrl) {
      children.push({
        type: 'embed',
        embedType: embedUrl.includes('youtube') || embedUrl.includes('youtu.be') ? 'youtube' : 'iframe',
        url: embedUrl,
        version: 1,
      });
    } else {
      // Check if raw HTML contains unknown tags or unhandled structures
      const plain = cleanText(originalHtml).trim();
      if (plain) {
        children.push({
          type: 'paragraph',
          format: '',
          indent: 0,
          version: 1,
          direction: 'ltr',
          children: parseInlineContent(originalHtml),
        });
      } else {
        unknownBlockDetected = true;
        reviewFlags.push('UNKNOWN_BLOCK_WRAP');
        children.push({
          type: 'paragraph',
          format: '',
          indent: 0,
          version: 1,
          direction: 'ltr',
          children: [{ type: 'text', text: originalHtml, format: 0, detail: 0, mode: 'normal', style: '', version: 1 }],
        });
      }
    }
  } else if (lastIndex < originalHtml.length) {
    const leftover = originalHtml.slice(lastIndex).trim();
    if (leftover && !leftover.startsWith('<!--')) {
      const plain = cleanText(leftover).trim();
      if (plain) {
        children.push({
          type: 'paragraph',
          format: '',
          indent: 0,
          version: 1,
          direction: 'ltr',
          children: parseInlineContent(leftover),
        });
      }
    }
  }

  return {
    ast: {
      root: {
        type: 'root',
        format: '',
        indent: 0,
        version: 1,
        direction: 'ltr',
        children,
      },
    },
    originalHtml,
    sha256,
    unknownBlockDetected,
    reviewFlags,
  };
}
