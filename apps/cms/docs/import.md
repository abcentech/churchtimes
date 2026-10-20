# WordPress import

## Converter

`src/import/htmlToLexical.ts` turns WordPress post HTML (Gutenberg block markup and classic-editor HTML) into the
serialized Lexical JSON that `articles.content` stores and the public renderer reads (go-live contract C1). It is pure:
no database, no network, no file access. The HTML is read with `parse5` (a spec-compliant parser); no markup is parsed
with a regular expression.

```ts
htmlToLexical(html, { oldHosts, slugMap, resolveImage, knownShortcodes?, articleTitle?, articlePath?,
                      maxInputBytes?, maxDepth?, maxNodes? }) -> { content: { root }, root, report }
```

`resolveImage(src, { alt, caption, articleTitle }) -> { mediaId } | null` is supplied by the loader (it creates or finds
the media document, see C1.2). `content` is what to store; `report` lists everything lossy.

### What is written

Only: `paragraph`, `heading` (h2 to h4, strictly non-skipping; h1 becomes h2, h5/h6 become h4), `quote`, `list` /
`listitem` (nested up to 6 levels), `link` (`fields: { url, newTab, linkType: 'custom' }`), `text` (format bitmask: bold 1,
italic 2, strikethrough 4, underline 8, code 16, subscript 32, superscript 64, merged for nesting), `linebreak`, `upload`
(`relationTo: 'media'`, `value: <id>`), `table` / `tablerow` / `tablecell` (`headerState` 1 row header, 2 first-column
header, 3 both; `colSpan` / `rowSpan` capped at 20; at most 100 rows and 20 columns, rows padded to a rectangle) and the
registered `youtubeEmbed` block (`{ type: 'block', version: 2, fields: { blockType, id, videoId, title? } }`, a 24-hex
deterministic `id`). Attributes (class, style, event handlers, ...) are never carried over.

### Behaviour

- Gutenberg: block comments are read (`wp:paragraph`, `heading`, `list`, `quote`, `pullquote`, `image`, `gallery`, `embed`
  and `core-embed/*`, `table`, `separator`, `html`, `shortcode`, `more`, `nextpage`, nested `group` / `columns`). Unknown
  blocks fall back to their inner HTML and are listed. `wp:more` and `<!--more-->` are a paragraph break, never a join.
- Classic: documents without block comments get `wpautop`-like handling: a blank line ends a paragraph, a single
  newline is a line break. In Gutenberg documents newlines are plain whitespace.
- Video: only YouTube is kept. The 11-character id is taken from `iframe` sources (`youtube.com/embed`,
  `youtube-nocookie.com/embed`, `youtu.be`, `watch?v=`, shorts), `[youtube ...]` and `[embed]` shortcodes, `wp:embed`
  blocks, old `object`/`embed` markup and bare YouTube URLs on their own line. Any other iframe/embed becomes a
  paragraph with the https link, or is dropped; always reported. `video`, `audio`, `script`, `style`, `form`, `input`,
  `svg` and similar are dropped with their contents.
- Links: after conversion `sanitizeLegacyLinks` (C1.5) runs; unsafe or unknown schemes become plain text.
  Shortcodes are removed with `stripShortcodes` (also when the opening and closing marker sit in different text
  nodes). Entities are decoded by the parser. Whitespace is normalised without joining words; `&nbsp;`-only blocks are
  dropped.
- Images: `resolveImage` decides. Resolved images become `upload` nodes followed by their caption paragraph; unresolved
  ones become a paragraph with the alt text and caption and are reported.

### Limits

Input over 5 MB (`maxInputBytes`) throws `HtmlConversionError('input-too-large')`. Element nesting deeper than 512 levels
throws `'too-deep'` while parsing: a tree adapter hook on parse5 itself sees every element the real parser opens (so
`<div/>`, raw text rules inside svg/math and implied tags are exactly what the parser does) and stops at once, because
parse5's cost grows with the square of the depth. Between 64 and 512 levels the deeper subtree is flattened to text and
reported. Gutenberg block comments are paired in one linear pass with an explicit stack; block nesting counts like
element nesting (flattened past 64 levels). More than `maxNodes` (20 000) output nodes throws `'too-many-nodes'`. Any
other failure is wrapped as `HtmlConversionError('invalid-output')`, never a raw error. The output is checked with
`findEmbedProblem` (embed and depth rules of the Articles validators) before it is returned. Addresses in the report carry
no user info, query string or fragment; warnings are capped at 50.

### QA report command

`npm run import:convert -- --in <folder of .html files> [--old-host a.test,b.test] [--slug-map map.json]
[--assume-images] [--detail-file <path outside the repository>]` converts every file without touching the database and
prints counts only (shortcodes removed by tag, unknown elements and blocks, tables flattened, unresolved images, embeds
linked or dropped, links unmapped, files that failed by code). Per-file details go to `--detail-file`, which must be
outside the repository. Exit code 1 when any file failed.

### Tests

`tests/unit/htmlToLexical.test.ts` (table-driven unit and adversarial cases), `tests/unit/htmlToLexicalCorpus.test.ts`
(48 synthetic articles from `tests/fixtures/html/corpus.ts`), `tests/unit/convertReport.test.ts` and
`tests/integration/import-lexical.test.ts` (converted bodies through the real REST handlers). All content is invented.
