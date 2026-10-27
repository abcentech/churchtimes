import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markdownToLexical, lexicalToMarkdown, markdownToHtml, countWords,
  imageToken, listImages, insertBlockLine, removeImageLine, stripImageLabels, MISSING_IMAGE_TOKEN, MAX_MEDIA_ID
} from '../src/lexical.js';

// Node shapes as Payload's Lexical editor stores them.
const T = (text, format = 0) => ({ type: 'text', text, format, detail: 0, mode: 'normal', style: '', version: 1 });
const P = (...kids) => ({ type: 'paragraph', children: kids, direction: 'ltr', format: '', indent: 0, version: 1 });
const U = (value, extra = {}) => ({
  type: 'upload', version: 3, format: '', id: '65f0c0ffee00112233445566', relationTo: 'media', fields: null, value, ...extra
});
const doc = (...children) => ({ root: { type: 'root', children, direction: 'ltr', format: '', indent: 0, version: 1 } });
const uploads = lex => lex.root.children.filter(n => n.type === 'upload');
const stripIds = node => { const { id, ...rest } = node; return rest; };

test('token <-> upload node: relationTo media, numeric value, version 3, fields null, 24-hex id', () => {
  const lex = markdownToLexical('![Choir on stage](media:42)');
  assert.equal(lex.root.children.length, 1);
  const [n] = lex.root.children;
  assert.equal(n.type, 'upload');
  assert.equal(n.relationTo, 'media');
  assert.strictEqual(n.value, 42);
  assert.equal(n.version, 3);
  assert.equal(n.fields, null);
  assert.equal(n.format, '');
  assert.match(n.id, /^[0-9a-f]{24}$/);
  assert.deepEqual(lexicalToMarkdown(lex), { markdown: '![](media:42)', lossy: false, images: [{ id: '42', alt: '', media: null }], missingImages: 0 });
});

test('images between paragraphs keep their position and order', () => {
  const md = 'First paragraph.\n\n![One](media:1)\n\nSecond paragraph.\n\n![Two](media:2)\n\nThird.';
  const lex = markdownToLexical(md);
  assert.deepEqual(lex.root.children.map(n => n.type), ['paragraph', 'upload', 'paragraph', 'upload', 'paragraph']);
  assert.deepEqual(uploads(lex).map(n => n.value), [1, 2]);
  const back = lexicalToMarkdown(lex);
  assert.equal(back.lossy, false);
  assert.deepEqual(back.images.map(i => i.id), ['1', '2']);
  assert.equal(back.markdown, 'First paragraph.\n\n![](media:1)\n\nSecond paragraph.\n\n![](media:2)\n\nThird.');
});

test('any number of images, including the same media twice, each get their own node id', () => {
  const md = Array.from({ length: 7 }, (_, i) => `![a](media:${i % 3 + 1})`).join('\n\n');
  const lex = markdownToLexical(md);
  const nodes = uploads(lex);
  assert.equal(nodes.length, 7);
  assert.deepEqual(nodes.map(n => n.value), [1, 2, 3, 1, 2, 3, 1]);
  assert.equal(new Set(nodes.map(n => n.id)).size, 7);
  // stable across conversions (re-saving does not churn ids)
  assert.deepEqual(markdownToLexical(md), lex);
});

test('image alone, first and last block', () => {
  assert.deepEqual(markdownToLexical('![x](media:9)').root.children.map(n => n.type), ['upload']);
  assert.deepEqual(markdownToLexical('![x](media:9)\n\ntext\n\n![y](media:10)').root.children.map(n => n.type), ['upload', 'paragraph', 'upload']);
});

test('an image line directly after text, a quote or a list ends that block', () => {
  const lex = markdownToLexical('para line\n![x](media:3)\n> quote\n![y](media:4)\n- item\n![z](media:5)');
  assert.deepEqual(lex.root.children.map(n => n.type), ['paragraph', 'upload', 'quote', 'upload', 'list', 'upload']);
});

test('id-only upload value (number or numeric string) is read and written back as the numeric id', () => {
  for (const value of [7, '7']) {
    const r = lexicalToMarkdown(doc(P(T('a')), U(value)));
    assert.equal(r.lossy, false);
    assert.equal(r.markdown, 'a\n\n![](media:7)');
    assert.deepEqual(r.images, [{ id: '7', alt: '', media: null }]);
    assert.strictEqual(markdownToLexical(r.markdown).root.children[1].value, 7);
  }
});

test('populated upload value (depth > 0): alt becomes the label, media is exposed, the id is written back', () => {
  const media = { id: 15, alt: 'Bishop [greets] crowd', url: '/api/media/file/a.png', mimeType: 'image/png', width: 800, height: 600 };
  const r = lexicalToMarkdown(doc(U(media)));
  assert.equal(r.lossy, false);
  assert.equal(r.markdown, '![Bishop \\[greets\\] crowd](media:15)');
  assert.equal(r.images[0].media, media);
  assert.equal(r.images[0].alt, 'Bishop [greets] crowd');
  const out = markdownToLexical(r.markdown).root.children[0];
  assert.strictEqual(out.value, 15); // an id, never the populated document
  assert.equal(typeof out.value, 'number');
  assert.deepEqual(listImages(r.markdown), [{ id: '15', alt: 'Bishop [greets] crowd', missing: false }]);
});

test('lossless round trip of existing CMS upload nodes (mixed id / populated, between paragraphs)', () => {
  const original = doc(
    P(T('Intro '), T('bold', 1)),
    U(3),
    P(T('Middle')),
    U({ id: 4, alt: 'Second *photo*', url: '/x.png' }),
    P(T('End')),
    U('5')
  );
  const first = lexicalToMarkdown(original);
  assert.equal(first.lossy, false);
  const rebuilt = markdownToLexical(first.markdown);
  assert.deepEqual(rebuilt.root.children.map(n => n.type), ['paragraph', 'upload', 'paragraph', 'upload', 'paragraph', 'upload']);
  // identical apart from the node ids and the (id-only) normalisation of the value
  assert.deepEqual(rebuilt.root.children.filter(n => n.type === 'upload').map(stripIds), [
    stripIds(U(3)), stripIds(U(4)), stripIds(U(5))
  ]);
  const second = lexicalToMarkdown(rebuilt);
  assert.equal(second.lossy, false);
  assert.equal(second.markdown.replace(/!\[[^\]]*\]/g, '![]'), first.markdown.replace(/!\[(?:\\.|[^\]\\])*\]/g, '![]'));
  assert.deepEqual(second.images.map(i => i.id), ['3', '4', '5']);
  // markdown -> lexical -> markdown -> lexical is a fixed point
  assert.deepEqual(markdownToLexical(second.markdown), rebuilt);
});

test('a body with upload nodes is NOT lossy; a trailing blank paragraph (Payload leaves one) is dropped', () => {
  assert.equal(lexicalToMarkdown(doc(P(T('x')), U(1))).lossy, false);
  assert.equal(lexicalToMarkdown(doc(P(T('x')), U(1), P())).lossy, false);
  assert.equal(lexicalToMarkdown(doc(U(1), P(T('after')))).lossy, false);
  assert.equal(lexicalToMarkdown(doc(U(1), U(2), U(3))).lossy, false);
  assert.equal(lexicalToMarkdown(doc(U(1))).markdown, '![](media:1)');
});

test('uploads the token cannot carry stay lossy (read-only body, nothing rewritten)', () => {
  const lossy = (...n) => lexicalToMarkdown(doc(...n)).lossy;
  assert.equal(lossy(U(1, { relationTo: 'documents' })), true);
  assert.equal(lossy(U(1, { fields: { caption: 'x' } })), true);
  assert.equal(lossy(U(1, { fields: [] })), true);
  assert.equal(lossy(U(1, { format: 'center' })), true);
  assert.equal(lossy(U(1, { pending: { formID: 'x', src: 'blob:' } })), true);
  assert.equal(lossy(U('abc123')), true); // not a numeric id
  assert.equal(lossy(U(0)), true);
  assert.equal(lossy(U(2147483648)), true); // beyond the CMS's integer ids
  assert.equal(lossy(U('007')), true);
  assert.equal(lossy(U(true)), true);
  assert.equal(lossy(U({ alt: 'no id' })), true);
  assert.equal(lossy(U(-4)), true);
  assert.equal(lossy(U(1.5)), true);
  // empty / default fields are fine
  assert.equal(lossy(U(1, { fields: {} })), false);
  assert.equal(lossy(U(1, { fields: undefined })), false);
  assert.equal(lossy(U(1, { format: 'left' })), false);
  // other unsupported nodes still make the body read-only
  assert.equal(lossy(P(T('x')), { type: 'horizontalrule', version: 1 }), true);
  assert.equal(lossy(P(T('x')), { type: 'block', version: 2, fields: {} }), true);
  assert.equal(lossy(U(1), { type: 'table', children: [] }), true);
});

test('text that merely looks like the token is plain text and cannot forge an image', () => {
  const lex = doc(P(T('![sneaky](media:99)')), P(T('before'), { type: 'linebreak', version: 1 }, T('![x](media:5)')));
  const r = lexicalToMarkdown(lex);
  assert.equal(r.lossy, false);
  assert.deepEqual(r.images, []);
  assert.deepEqual(listImages(r.markdown), []);
  const back = markdownToLexical(r.markdown);
  assert.deepEqual(back.root.children.map(n => n.type), ['paragraph', 'paragraph']);
  assert.equal(back.root.children[0].children[0].text, '![sneaky](media:99)');
});

test('token inside a sentence, with a non-numeric id, or with extra text is not an image', () => {
  for (const md of ['see ![x](media:1) here', '![x](media:abc)', '![x](media:1) caption', '![x](media:)', '![x](https://e.org/a.png)', '![x](media:12345678901234567)']) {
    assert.deepEqual(markdownToLexical(md).root.children.map(n => n.type), ['paragraph'], md);
  }
  // surrounding whitespace on the token's own line is fine
  assert.deepEqual(markdownToLexical('   ![x](media:1)   ').root.children.map(n => n.type), ['upload']);
});

test('imageToken: label is single-line and bracket safe; invalid ids give no token', () => {
  assert.equal(imageToken(5, 'A photo'), '![A photo](media:5)');
  assert.equal(imageToken('5'), '![](media:5)');
  assert.equal(imageToken(5, 'multi\nline  text'), '![multi line text](media:5)');
  assert.equal(imageToken(5, 'a ] b [ c \\ d * e'), '![a \\] b \\[ c \\\\ d \\* e](media:5)');
  assert.equal(imageToken(5, 'x'.repeat(400)).length, '![](media:5)'.length + 300);
  for (const bad of [0, -1, 'abc', null, undefined, '', 1.5, '1e3']) assert.equal(imageToken(bad, 'x'), '', String(bad));
  // whatever the label, the line parses back to exactly this image
  for (const alt of ['a ] b', 'x\\', '`code` <b>x</b>', '(paren)', '![nested](media:9)', '\\]']) {
    const line = imageToken(11, alt);
    const lex = markdownToLexical(line);
    assert.deepEqual(lex.root.children.map(n => n.type), ['upload'], alt);
    assert.strictEqual(lex.root.children[0].value, 11);
    assert.deepEqual(listImages(line).map(i => i.id), ['11']);
  }
});

test('listImages reads every token line in order', () => {
  const md = 'a\n\n![One](media:1)\n\nb ![no](media:2)\n\n![Two \\] x](media:3)\r\n![](media:4)\n![gone](media:04)\n![](media:missing)\n![missing image](media:missing)';
  assert.deepEqual(listImages(md), [
    { id: '1', alt: 'One', missing: false }, { id: '3', alt: 'Two ] x', missing: false }, { id: '4', alt: '', missing: false },
    { id: '', alt: 'missing image', missing: true }
  ]);
  assert.deepEqual(listImages(''), []);
  assert.deepEqual(listImages(undefined), []);
});

test('insertBlockLine puts the token on its own line at the cursor', () => {
  const line = '![x](media:1)';
  assert.deepEqual(insertBlockLine('', 0, 0, line), { value: `${line}\n\n`, caret: line.length + 2 });
  const mid = insertBlockLine('Hello world', 5, 5, line);
  assert.equal(mid.value, `Hello\n\n${line}\n\n world`);
  assert.equal(mid.caret, `Hello\n\n${line}\n\n`.length);
  assert.equal(insertBlockLine('Para one.\n\nPara two.', 11, 11, line).value, `Para one.\n\n${line}\n\nPara two.`);
  assert.equal(insertBlockLine('Para one.\n', 10, 10, line).value, `Para one.\n\n${line}\n\n`);
  assert.equal(insertBlockLine('Para one.', 9, 9, line).value, `Para one.\n\n${line}\n\n`);
  assert.equal(insertBlockLine('a\nb', 2, 2, line).value, `a\n\n${line}\n\nb`);
  // a selection is replaced
  assert.equal(insertBlockLine('keep SELECTED keep', 5, 13, line).value, `keep \n\n${line}\n\n keep`);
  // out-of-range / missing positions append
  assert.equal(insertBlockLine('abc', 99, 99, line).value, `abc\n\n${line}\n\n`);
  assert.equal(insertBlockLine('abc', undefined, undefined, line).value, `abc\n\n${line}\n\n`);
  // the result always parses to paragraph / upload / paragraph
  const lex = markdownToLexical(insertBlockLine('Hello world', 5, 5, line).value);
  assert.deepEqual(lex.root.children.map(n => n.type), ['paragraph', 'upload', 'paragraph']);
});

test('removeImageLine removes only the chosen occurrence and tidies blank lines', () => {
  const md = 'a\n\n![](media:1)\n\nb\n\n![](media:1)\n\nc';
  assert.equal(removeImageLine(md, 0), 'a\n\nb\n\n![](media:1)\n\nc');
  assert.equal(removeImageLine(md, 1), 'a\n\n![](media:1)\n\nb\n\nc');
  assert.equal(removeImageLine(md, 2), md);
  assert.equal(removeImageLine('![](media:1)\n\nfirst', 0), 'first');
  assert.equal(removeImageLine('last\n\n![](media:1)', 0), 'last\n');
});

test('countWords ignores image token lines', () => {
  assert.equal(countWords('one two\n\n![A long alt text here](media:5)\n\nthree'), 3);
  assert.equal(countWords('inline ![not a token](media:5) stays'), 7);
});

test('preview HTML: known media renders a figure with escaped src/alt; unknown ids a text label; nothing is raw HTML', () => {
  const md = 'Before\n\n![label <b>x</b>](media:5)\n\n![other](media:6)';
  const media = id => (id === '5' ? { url: '/api/media/file/a"onerror="x.png', alt: '<img src=x onerror=alert(1)>' } : null);
  const html = markdownToHtml(md, { media });
  assert.match(html, /<figure class="preview-inline-figure" data-testid="preview-inline-image" data-media-id="5"><img src="\/api\/media\/file\/a&quot;onerror=&quot;x\.png" alt="&lt;img src=x onerror=alert\(1\)&gt;"/);
  assert.ok(!html.includes('<img src=x'), 'alt is escaped');
  assert.ok(!html.includes('<b>'), 'label is escaped');
  assert.match(html, /<figure class="preview-inline-figure preview-inline-missing"[^>]*data-media-id="6"><figcaption>Image #6: other<\/figcaption>/);
  // without a resolver every image is a label
  assert.match(markdownToHtml('![x](media:7)'), /Image #7: x/);
  assert.ok(!markdownToHtml('![x](media:7)').includes('<img'));
  // a media entry with no usable URL falls back to the label
  assert.ok(!markdownToHtml('![x](media:7)', { media: () => ({ url: '', thumbUrl: '', alt: 'y' }) }).includes('<img'));
});

test('stripImageLabels empties labels only on image token lines', () => {
  const md = 'a ![keep](media:1) b\n\n![Some label](media:7)\n\n![](media:2)\r\n![x\\]y](media:3)\n![gone](media:missing)\n![zero](media:0)';
  assert.equal(stripImageLabels(md), 'a ![keep](media:1) b\n\n![](media:7)\n\n![](media:2)\n![](media:3)\n![gone](media:missing)\n![zero](media:0)');
  assert.equal(stripImageLabels(undefined), '');
});

test('only ids 1..2147483647 without leading zeros are images; everything else stays plain text', () => {
  assert.equal(MAX_MEDIA_ID, 2147483647);
  const types = md => markdownToLexical(md).root.children.map(n => n.type);
  assert.deepEqual(types('![x](media:1)'), ['upload']);
  assert.deepEqual(types('![x](media:2147483647)'), ['upload']);
  assert.strictEqual(markdownToLexical('![x](media:2147483647)').root.children[0].value, 2147483647);
  for (const bad of ['0', '00', '01', '007', '2147483648', '9999999999', '10000000000', '-1', '1.5', '1e3', '']) {
    assert.deepEqual(types(`![x](media:${bad})`), ['paragraph'], bad);
    assert.deepEqual(listImages(`![x](media:${bad})`), [], bad);
  }
  for (const ok of [1, 2147483647, '2147483647']) assert.notEqual(imageToken(ok, 'x'), '');
  for (const bad of [0, '0', '01', 2147483648, '2147483648', 9999999999]) assert.equal(imageToken(bad, 'x'), '', String(bad));
  assert.equal(countWords('a\n\n![alt](media:2147483647)\n\nb'), 2);
  assert.ok(countWords('a\n\n![alt words here](media:0)\n\nb') > 2); // not an image line: counted as text
});

test('an upload node whose media was deleted (value null) is editable: it shows as a removable "missing image" line', () => {
  for (const value of [null, undefined]) {
    const r = lexicalToMarkdown(doc(P(T('before')), U(value), P(T('after'))));
    assert.equal(r.lossy, false, 'the body stays editable');
    assert.equal(r.missingImages, 1);
    assert.deepEqual(r.images, []);
    assert.equal(r.markdown, `before\n\n${MISSING_IMAGE_TOKEN}\n\nafter`);
  }
  // it converts back to an upload node pointing at nothing (the CMS refuses to save that), so keeping it is never silent
  const back = markdownToLexical(`before\n\n${MISSING_IMAGE_TOKEN}\n\nafter`);
  assert.deepEqual(back.root.children.map(n => n.type), ['paragraph', 'upload', 'paragraph']);
  assert.strictEqual(back.root.children[1].value, null);
  assert.equal(back.root.children[1].relationTo, 'media');
  // round trip is stable
  assert.equal(lexicalToMarkdown(back).markdown, `before\n\n${MISSING_IMAGE_TOKEN}\n\nafter`);
  // removing the line gives a clean body with no upload node
  const listed = listImages(`before\n\n${MISSING_IMAGE_TOKEN}\n\nafter`);
  assert.deepEqual(listed, [{ id: '', alt: 'missing image', missing: true }]);
  const cleaned = removeImageLine(`before\n\n${MISSING_IMAGE_TOKEN}\n\nafter`, 0);
  assert.equal(cleaned, 'before\n\nafter');
  assert.deepEqual(markdownToLexical(cleaned).root.children.map(n => n.type), ['paragraph', 'paragraph']);
  // two missing + a real one: counted and ordered
  const mixed = lexicalToMarkdown(doc(U(null), U(8), U(null)));
  assert.equal(mixed.missingImages, 2);
  assert.deepEqual(listImages(mixed.markdown).map(i => i.missing), [true, false, true]);
  // the missing token is untouched by label stripping, ignored by the word count and rendered as a warning
  assert.equal(stripImageLabels(MISSING_IMAGE_TOKEN), MISSING_IMAGE_TOKEN);
  assert.equal(countWords(`a\n\n${MISSING_IMAGE_TOKEN}\n\nb`), 2);
  const html = markdownToHtml(MISSING_IMAGE_TOKEN);
  assert.match(html, /data-testid="preview-inline-image-missing"/);
  assert.match(html, /Remove this line before saving/);
  assert.ok(!html.includes('<img'));
  // a missing token with other text, or inside a sentence, is just text
  assert.deepEqual(markdownToLexical(`see ${MISSING_IMAGE_TOKEN}`).root.children.map(n => n.type), ['paragraph']);
});

test('other broken uploads (populated without an id, wrong collection) are still read-only', () => {
  assert.equal(lexicalToMarkdown(doc(U({ alt: 'x' }))).lossy, true);
  assert.equal(lexicalToMarkdown(doc(U(null, { relationTo: 'documents' }))).lossy, true);
  assert.equal(lexicalToMarkdown(doc(U(null, { fields: { a: 1 } }))).lossy, true);
});
