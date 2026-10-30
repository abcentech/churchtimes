import test from 'node:test';
import assert from 'node:assert/strict';
import {
  galleryMediaOf, galleryToken, lexicalToMarkdown, listGalleries, markdownToHtml, markdownToLexical, matchGalleryLine,
  matchPullQuoteLine, pullQuoteToken
} from '../src/lexical.js';

const children = md => markdownToLexical(md).root.children;

test('pull quote line <-> pullQuote block', () => {
  const [node] = children('>> We will rebuild. -- Bishop A');
  assert.equal(node.type, 'block');
  assert.equal(node.fields.blockType, 'pullQuote');
  assert.equal(node.fields.quote, 'We will rebuild.');
  assert.equal(node.fields.attribution, 'Bishop A');
  assert.match(node.fields.id, /^[0-9a-f]{24}$/);
  const back = lexicalToMarkdown({ root: { children: [node] } });
  assert.deepEqual([back.markdown, back.lossy], ['>> We will rebuild. -- Bishop A', false]);
});

test('pull quote tokens round-trip awkward text', () => {
  for (const [q, a] of [['Plain', ''], ['a -- b', ''], ['x --', ''], ['Use -- carefully', 'Ada']]) {
    const parsed = matchPullQuoteLine(pullQuoteToken(q, a));
    assert.deepEqual(parsed, { quote: q, attribution: a });
  }
  assert.equal(pullQuoteToken('  '), '');
  // An ordinary quote is still a quote, not a pull quote.
  assert.equal(children('> Just a quote')[0].type, 'quote');
});

test('gallery line <-> gallery block, ids validated', () => {
  const [node] = children('[gallery](media:12, 13,14)');
  assert.equal(node.fields.blockType, 'gallery');
  assert.deepEqual(node.fields.images.map(r => r.image), [12, 13, 14]);
  assert.ok(node.fields.images.every(r => /^[0-9a-f]{24}$/.test(r.id)));
  assert.equal(new Set(node.fields.images.map(r => r.id)).size, 3);
  assert.deepEqual(matchGalleryLine('[gallery](media:0)'), null);
  assert.deepEqual(matchGalleryLine('[gallery](media:1,x)'), null);
  assert.equal(galleryToken(['5', 'bad', '6']), '[gallery](media:5,6)');
  assert.deepEqual(listGalleries('a\n[gallery](media:1)\nb\n[gallery](media:2,3)'), [['1'], ['2', '3']]);
  const back = lexicalToMarkdown({ root: { children: [node] } });
  assert.deepEqual([back.markdown, back.lossy], ['[gallery](media:12,13,14)', false]);
});

test('a populated gallery reads back to ids; captions, block names or unknown blocks make the body read-only', () => {
  const gallery = images => ({ type: 'block', version: 2, format: '', fields: { id: 'g', blockName: '', blockType: 'gallery', images } });
  const populated = lexicalToMarkdown({ root: { children: [gallery([{ id: 'r', image: { id: 7, alt: 'Choir', url: '/x.jpg' } }])] } });
  assert.deepEqual([populated.markdown, populated.lossy], ['[gallery](media:7)', false]);
  assert.equal(lexicalToMarkdown({ root: { children: [gallery([{ id: 'r', image: 7, caption: 'Story caption' }])] } }).lossy, true);
  const named = { type: 'block', version: 2, format: '', fields: { id: 'q', blockName: 'Named', blockType: 'pullQuote', quote: 'Q', attribution: '' } };
  assert.equal(lexicalToMarkdown({ root: { children: [named] } }).lossy, true);
  const yt = { type: 'block', version: 2, format: '', fields: { id: 'y', blockName: '', blockType: 'youtubeEmbed', videoId: 'dQw4w9WgXcQ' } };
  assert.equal(lexicalToMarkdown({ root: { children: [yt] } }).lossy, true);
  assert.deepEqual(galleryMediaOf({ root: { children: [gallery([{ image: { id: 7, alt: 'Choir' } }, { image: 8 }])] } }).map(m => m.id), [7]);
});

test('preview renders blocks as escaped text, never HTML', () => {
  const html = markdownToHtml('>> <img src=x onerror=alert(1)> -- <b>Me</b>\n\n[gallery](media:3)', { media: id => (id === '3' ? { thumbUrl: '/t.jpg', alt: 'A "quoted" alt' } : null) });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;b&gt;Me&lt;/b&gt;'));
  assert.ok(html.includes('alt="A &quot;quoted&quot; alt"'));
  assert.ok(html.includes('data-testid="preview-gallery"'));
});

test('a paragraph that merely contains the token text is escaped and stays a paragraph', () => {
  const lex = { root: { children: [{ type: 'paragraph', version: 1, format: '', indent: 0, direction: 'ltr', children: [{ type: 'text', version: 1, text: '>> not a quote', format: 0, mode: 'normal', style: '', detail: 0 }] }] } };
  const md = lexicalToMarkdown(lex).markdown;
  assert.equal(children(md)[0].type, 'paragraph');
});
