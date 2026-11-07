// Query-term highlighting. Works on plain strings and DOM text nodes only: server text is never parsed as HTML.
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Words worth highlighting from a websearch-style query: no operators, no negated terms, at least 2 characters. */
export function queryTerms(query) {
  if (typeof query !== 'string') return [];
  const terms = new Set();
  for (const raw of query.slice(0, 200).split(/\s+/)) {
    if (!raw || raw.startsWith('-') || /^or$/i.test(raw)) continue;
    const word = raw.replace(/^["'“”‘’(]+|["'“”‘’),.;:!?]+$/g, '');
    if (word.length >= 2) terms.add(word.toLowerCase());
  }
  // Longest first so "church" wins over "ch" in the alternation.
  return [...terms].sort((a, b) => b.length - a.length).slice(0, 12);
}

/** Splits text into `{text, match}` segments. Matches start at a word boundary (search stems, so "church" also marks "churches"). */
export function highlightSegments(text, terms) {
  const value = String(text ?? '');
  if (!value || !terms?.length) return value ? [{ text: value, match: false }] : [];
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${terms.map(escapeRegExp).join('|')})`, 'giu');
  const segments = [];
  let last = 0;
  for (const found of value.matchAll(pattern)) {
    const start = found.index + found[1].length;
    const end = start + found[2].length;
    if (start > last) segments.push({ text: value.slice(last, start), match: false });
    segments.push({ text: value.slice(start, end), match: true });
    last = end;
  }
  if (last < value.length) segments.push({ text: value.slice(last), match: false });
  return segments;
}

/** Wraps matches inside the text nodes of `elements` in <mark>. Safe to run twice (existing marks are skipped). */
export function highlightElements(elements, query, doc = globalThis.document) {
  const terms = queryTerms(query);
  if (!terms.length) return 0;
  let count = 0;
  for (const element of elements) {
    const walker = doc.createTreeWalker(element, 4 /* NodeFilter.SHOW_TEXT */);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!node.parentElement?.closest('mark')) nodes.push(node);
    for (const node of nodes) {
      const segments = highlightSegments(node.nodeValue, terms);
      if (!segments.some(s => s.match)) continue;
      const fragment = doc.createDocumentFragment();
      for (const segment of segments) {
        if (segment.match) { const mark = doc.createElement('mark'); mark.className = 'growth-mark'; mark.textContent = segment.text; fragment.append(mark); count += 1; }
        else fragment.append(doc.createTextNode(segment.text));
      }
      node.replaceWith(fragment);
    }
  }
  return count;
}
