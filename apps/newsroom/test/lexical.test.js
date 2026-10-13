import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToLexical, lexicalToMarkdown, markdownToHtml, isSafeUrl } from '../src/lexical.js';

const SAMPLE = [
  '## A heading',
  'First paragraph with **bold**, *italic* and a [link](https://example.org/a?b=1).\nSecond line.',
  '### Sub-heading',
  '> "A quote"',
  '- one\n- two **b**',
  '1. first\n2. second',
  'Last paragraph.'
].join('\n\n');

test('markdown -> lexical -> markdown is stable for the supported subset', () => {
  const lex = markdownToLexical(SAMPLE);
  const { markdown, lossy } = lexicalToMarkdown(lex);
  assert.equal(lossy, false);
  assert.equal(markdown, SAMPLE);
});

test('lexical output has the node shapes Payload and the public renderer read', () => {
  const lex = markdownToLexical('## H\n\nHello **world** [x](https://e.org)\n\n- a');
  const [h, p, list] = lex.root.children;
  assert.equal(lex.root.type, 'root');
  assert.equal(h.type, 'heading');
  assert.equal(h.tag, 'h2');
  assert.equal(p.children[1].format, 1);
  assert.equal(p.children[3].type, 'link');
  assert.equal(p.children[3].fields.url, 'https://e.org');
  assert.equal(list.type, 'list');
  assert.equal(list.listType, 'bullet');
  assert.equal(list.children[0].type, 'listitem');
});

test('empty input yields one empty paragraph (never an empty root)', () => {
  const lex = markdownToLexical('   ');
  assert.equal(lex.root.children.length, 1);
  assert.equal(lex.root.children[0].type, 'paragraph');
  assert.equal(lexicalToMarkdown(lex).markdown, '');
});

test('special characters survive a round trip', () => {
  const md = String.raw`Star \* and bracket \[x\] and # not a heading`;
  const lex = markdownToLexical(md);
  assert.equal(lex.root.children[0].type, 'paragraph');
  assert.equal(lexicalToMarkdown(lex).markdown, md);
  const literal = { root: { children: [{ type: 'paragraph', children: [{ type: 'text', text: '- not a list', format: 0 }] }] } };
  const out = lexicalToMarkdown(literal).markdown;
  assert.equal(markdownToLexical(out).root.children[0].type, 'paragraph');
});

test('unsupported nodes and formats set lossy', () => {
  assert.equal(lexicalToMarkdown({ root: { children: [{ type: 'upload', value: 3 }] } }).lossy, true);
  assert.equal(lexicalToMarkdown({ root: { children: [{ type: 'paragraph', children: [{ type: 'text', text: 'x', format: 8 }] }] } }).lossy, true);
  assert.equal(lexicalToMarkdown({ root: { children: [{ type: 'heading', tag: 'h4', children: [{ type: 'text', text: 'x', format: 0 }] }] } }).lossy, true);
});

test('javascript: and data: links are never emitted as links', () => {
  assert.equal(isSafeUrl('javascript:alert(1)'), false);
  const lex = markdownToLexical('[bad](javascript:alert(1)) text');
  assert.equal(JSON.stringify(lex).includes('"type":"link"'), false);
  assert.equal(markdownToHtml('[bad](javascript:alert(1))').includes('<a '), false);
});

test('preview HTML escapes markup', () => {
  const html = markdownToHtml('<img src=x onerror=alert(1)> **<b>x</b>**');
  assert.equal(html.includes('<img'), false);
  assert.ok(html.includes('&lt;img'));
});

// ---------------------------------------------------------------------------------------------------------
// Round-trip fidelity (every format combination, special characters, adjacency) and lossy detection
// ---------------------------------------------------------------------------------------------------------

const T = (text, format = 0, extra = {}) => ({ type: 'text', text, format, detail: 0, mode: 'normal', style: '', version: 1, ...extra });
const A = (url, children, fields = {}) => ({ type: 'link', version: 3, fields: { linkType: 'custom', newTab: false, url, ...fields }, children });
const P = (children, extra = {}) => ({ type: 'paragraph', version: 1, format: '', indent: 0, direction: 'ltr', children, ...extra });
const BR = { type: 'linebreak', version: 1 };
const doc = (...children) => ({ root: { type: 'root', version: 1, format: '', indent: 0, direction: 'ltr', children } });

/** Flatten inline nodes to {text, fmt, url} runs, merging adjacent runs with identical formatting. */
function runsOf(nodes, url = '') {
  const out = [];
  const push = (text, fmt, u) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.fmt === fmt && last.url === u) last.text += text;
    else out.push({ text, fmt, url: u });
  };
  for (const n of nodes) {
    if (n.type === 'text') push(n.text, n.format, url);
    else if (n.type === 'link') for (const r of runsOf(n.children, n.fields.url)) push(r.text, r.fmt, r.url);
    else if (n.type === 'linebreak') push('\n', 0, url);
  }
  return out;
}

function roundTrip(lex) {
  const first = lexicalToMarkdown(lex);
  const back = markdownToLexical(first.markdown);
  const second = lexicalToMarkdown(back);
  return { first, back, second };
}

function assertParagraphRoundTrip(children, label) {
  const { first, back, second } = roundTrip(doc(P(children)));
  assert.equal(first.lossy, false, `${label}: lossy`);
  assert.equal(back.root.children.length, 1, `${label}: block count for ${JSON.stringify(first.markdown)}`);
  assert.equal(back.root.children[0].type, 'paragraph', `${label}: block type for ${JSON.stringify(first.markdown)}`);
  assert.deepEqual(runsOf(back.root.children[0].children), runsOf(children), `${label}: runs for ${JSON.stringify(first.markdown)}`);
  assert.equal(second.markdown, first.markdown, `${label}: markdown is stable`);
}

const NASTY = ['plain', 'a*b', 'a]b', 'a[b', 'a\\b', '*[]\\', '\\*', 'ends with slash\\', '**', '***', '*', '[x](https://evil.example)', '_u_ `c`'];

test('every format 0..3 round-trips with * [ ] \\ in the text', () => {
  for (const fmt of [0, 1, 2, 3]) {
    for (const text of NASTY) {
      assertParagraphRoundTrip([T(text, fmt)], `fmt ${fmt} ${JSON.stringify(text)}`);
      assertParagraphRoundTrip([T('before '), T(text, fmt), T(' after')], `fmt ${fmt} inline ${JSON.stringify(text)}`);
    }
  }
});

test('bold+italic (format 3) is written as *** and read back as one bold+italic run', () => {
  const { markdown } = lexicalToMarkdown(doc(P([T('both', 3)])));
  assert.equal(markdown, '***both***');
  const back = markdownToLexical('***both***').root.children[0].children;
  assert.deepEqual(back.map(n => [n.text, n.format]), [['both', 3]]);
});

test('adjacent differently-formatted nodes stay separate (all ordered pairs of formats)', () => {
  for (const f1 of [0, 1, 2, 3]) {
    for (const f2 of [0, 1, 2, 3]) {
      for (const [x, y] of [['one', 'two'], ['a*b', 'c]d'], ['\\', '*'], ['x*', '*y']]) {
        assertParagraphRoundTrip([T(x, f1), T(y, f2)], `pair ${f1}/${f2} ${JSON.stringify([x, y])}`);
        assertParagraphRoundTrip([T(x, f1), T(y, f2), T(x, f1)], `triple ${f1}/${f2} ${JSON.stringify([x, y])}`);
      }
    }
  }
  // the specific merge cases from the review
  assertParagraphRoundTrip([T('bold', 1), T('both', 3)], 'bold then bold-italic');
  assertParagraphRoundTrip([T('both', 3), T('bold', 1)], 'bold-italic then bold');
  assertParagraphRoundTrip([T('it', 2), T('both', 3)], 'italic then bold-italic');
});

test('links round-trip: ] [ * \\ in link text, formatted link text, neighbours', () => {
  for (const url of ['https://example.org/a?b=1&c=2', 'mailto:desk@example.org']) {
    for (const fmt of [0, 1, 2, 3]) {
      for (const text of NASTY) {
        assertParagraphRoundTrip([A(url, [T(text, fmt)])], `link ${fmt} ${JSON.stringify(text)}`);
        assertParagraphRoundTrip([T('see '), A(url, [T(text, fmt)]), T(' now', 1)], `link inline ${fmt} ${JSON.stringify(text)}`);
      }
    }
  }
  assertParagraphRoundTrip([A('https://e.org', [T('plain '), T('bold', 1), T(' both', 3), T('it]', 2)])], 'mixed link children');
  assertParagraphRoundTrip([A('https://e.org/1', [T('one')]), A('https://e.org/2', [T('two', 3)])], 'adjacent links');
});

test('headings, quotes and list items round-trip special characters and formats', () => {
  const inline = [T('a*b ', 0), T('c]d', 3), T(' e\\', 1)];
  const lex = doc(
    { type: 'heading', tag: 'h2', format: '', indent: 0, children: inline },
    { type: 'quote', format: '', indent: 0, children: inline },
    { type: 'list', listType: 'bullet', start: 1, tag: 'ul', format: '', indent: 0, children: [{ type: 'listitem', value: 1, format: '', indent: 0, children: inline }] },
    { type: 'list', listType: 'number', start: 1, tag: 'ol', format: '', indent: 0, children: [{ type: 'listitem', value: 1, format: '', indent: 0, children: inline }] }
  );
  const { first, back } = roundTrip(lex);
  assert.equal(first.lossy, false);
  assert.deepEqual(back.root.children.map(c => c.type), ['heading', 'quote', 'list', 'list']);
  assert.deepEqual(runsOf(back.root.children[0].children), runsOf(inline));
  assert.deepEqual(runsOf(back.root.children[1].children), runsOf(inline));
  assert.deepEqual(runsOf(back.root.children[2].children[0].children), runsOf(inline));
  assert.deepEqual(runsOf(back.root.children[3].children[0].children), runsOf(inline));
});

const lossyOf = (...blocks) => lexicalToMarkdown(doc(...blocks)).lossy;
const H = (children, extra = {}) => ({ type: 'heading', tag: 'h2', format: '', indent: 0, children, ...extra });
const list = (extra = {}, itemExtra = {}) => ({
  type: 'list', listType: 'bullet', start: 1, tag: 'ul', format: '', indent: 0,
  children: [{ type: 'listitem', value: 1, format: '', indent: 0, children: [T('item')], ...itemExtra }], ...extra
});

test('plain supported documents are not lossy', () => {
  assert.equal(lossyOf(P([T('x')]), H([T('h')], { tag: 'h3' }), list(), list({ listType: 'number', tag: 'ol' })), false);
  assert.equal(lossyOf(P([])), false); // a new, empty story is one empty paragraph
  assert.equal(lossyOf(P([T('x')], { format: 'left' })), false);
});

test('link new-tab / rel / non-custom link types set lossy', () => {
  assert.equal(lossyOf(P([A('https://e.org', [T('x')], { newTab: true })])), true);
  assert.equal(lossyOf(P([A('https://e.org', [T('x')], { rel: 'nofollow' })])), true);
  assert.equal(lossyOf(P([A('https://e.org', [T('x')], { linkType: 'internal' })])), true);
  assert.equal(lossyOf(P([A('https://e.org', [])])), true);
  assert.equal(lossyOf(P([A('javascript:alert(1)', [T('x')])])), true);
});

test('alignment, indent and text style set lossy', () => {
  for (const fmt of ['center', 'right', 'justify', 'end']) assert.equal(lossyOf(P([T('x')], { format: fmt })), true, fmt);
  assert.equal(lossyOf(P([T('x')], { indent: 1 })), true);
  assert.equal(lossyOf(H([T('h')], { format: 'center' })), true);
  assert.equal(lossyOf({ type: 'quote', format: '', indent: 2, children: [T('q')] }), true);
  assert.equal(lossyOf(list({ format: 'right' })), true);
  assert.equal(lossyOf(list({}, { indent: 1 })), true);
  assert.equal(lossyOf(list({}, { format: 'center' })), true);
  assert.equal(lossyOf(P([T('x', 0, { style: 'color: red;' })])), true);
});

test('ordered list start != 1, checklists, empty paragraphs and in-line breaks set lossy', () => {
  assert.equal(lossyOf(list({ listType: 'number', tag: 'ol', start: 3 })), true);
  assert.equal(lossyOf(list({ listType: 'number', tag: 'ol', start: 1 })), false);
  assert.equal(lossyOf(list({ listType: 'check', tag: 'ul' }, { checked: false })), true);
  assert.equal(lossyOf(list({}, { checked: true })), true);
  assert.equal(lossyOf(P([T('a')]), P([]), P([T('b')])), true);
  assert.equal(lossyOf(P([T('a')]), P([T('  ')]), P([T('b')])), true);
  // trailing blank paragraphs (Payload's editor leaves one) are dropped, not lossy
  assert.equal(lossyOf(P([T('a')]), P([T('  ')])), false);
  assert.equal(lossyOf(P([T('a')]), P([]), P([])), false);
  assert.equal(lossyOf(H([T('a'), BR, T('b')])), true);
  assert.equal(lossyOf(list({}, { children: [T('a'), BR, T('b')] })), true);
  assert.equal(lossyOf(H([])), true);
  // a line break inside a paragraph or quote is representable
  assert.equal(lossyOf(P([T('a'), BR, T('b')])), false);
  assert.equal(lossyOf({ type: 'quote', format: '', indent: 0, children: [T('a'), BR, T('b')] }), false);
});
