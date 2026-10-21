# WordPress archive import (CMS)

Status: a safe streaming WXR reader (`src/import/wxr.ts`) with a parse-only report, the HTML to Lexical converter and
the database loader (see "Loader" below) exist. Contract: `go-live-contracts.md` (C1, C2, C6, C7).

## What the owner provides, and keeps OUTSIDE GitHub

Everything below is private data. None of it is ever committed, pasted into an issue or attached to a pull request.

| Item | Where to keep it (example) |
| --- | --- |
| The WordPress export file (WXR, `.xml`) | `D:\churchtimes-private\export.xml` |
| The `wp-content/uploads` folder (images) | `D:\churchtimes-private\uploads\` |
| The Rank Math redirects export | `D:\churchtimes-private\redirects.csv` |

The commands refuse an input or output path inside the repository.

## Safe order of a first dry run

1. **Parse-only report** (this part). Reads the file, prints counts, touches no database and no network.
2. Convert-only QA (later part): converts to the CMS shapes in memory and writes a QA report outside the repo.
3. Throwaway PostgreSQL import (later part): a local scratch database, never staging or production.
4. Open a sample of imported articles in the admin editor (tables, video, images, links).
5. Run again and roll back, to prove the import is repeatable and reversible.
6. Staging only after the owner has reviewed the QA report and samples.

## `npm run import:wxr-report`

```
cd apps/cms
npm run import:wxr-report -- --file D:\churchtimes-private\export.xml
npm run import:wxr-report -- --file D:\churchtimes-private\export.xml --detail-file D:\churchtimes-private\report-rows.jsonl
```

Parse only. Output is **counts only**: no title, slug, URL, name, email or article text. The only strings taken from the
file are shortcode tag names (top 30) and iframe host names (top 30). It prints:

- items by kind; posts by status (`publish`, `draft`, `private`, `pending`, `future`, `trash`, `auto-draft`, `inherit`);
- published posts, with the difference from the **4,346** the owner has in WordPress;
- published posts without a slug, duplicate-slug groups, password-protected posts, missing GMT dates (and how many
  fell back to local time), items with no usable date;
- categories per published post (0, 1, 2, 3, 4, 5+);
- published posts with shortcode-like tags, iframes (hosts), `<table>`, `<img>`, Gutenberg blocks versus classic, YouTube;
- comments by approved status and type, and approved comments on published posts (the audit had 1,833);
- attachments (with URL, alt text, attached file);
- Rank Math title and description counts and how many contain `%variables%` (these are dropped on import, C2).

`--detail-file <path>` additionally writes one JSON line per item (id, kind, status, slug, title, date, flags). It is
the only way titles or slugs leave the file. It must be outside the repository and must not already exist.

Errors print one short code and exit non-zero; the code never contains data. `WXR_UNREADABLE`, `WXR_FILE_TOO_LARGE`
(over 2 GB), `WXR_DOCTYPE` (a DOCTYPE or ENTITY was found), `WXR_ITEM_TOO_LARGE` (over 20 MB), `WXR_TOO_MANY_ITEMS`
(over 500,000), `WXR_TOO_DEEP` (over 32 levels), `WXR_MALFORMED`, `WXR_TRUNCATED`, `WXR_NOT_WXR`, `WXR_ENCODING`, `REPORT_DETAIL_FAILED`, `REPORT_USAGE`,
`REPORT_FILE_INSIDE_REPO`, `REPORT_DETAIL_INSIDE_REPO`, `REPORT_DETAIL_EXISTS`.

## What the reader guarantees

- Streaming: the file is read in chunks; it is never loaded whole.
- Any DOCTYPE or ENTITY declaration is refused (external entities and entity-expansion attacks).
- Limits on file size, single item size, item count and nesting depth.
- No network access and no file writes in the reader.
- Commenter email, URL and IP and author email are never read; the output types have no field for them.
- Dates come from `wp:post_date_gmt` as UTC. When it is not a valid date (the WordPress zero date
  `0000-00-00 00:00:00`, an empty value, or any text or impossible date that cannot be parsed) `wp:post_date` (site
  local time) is used instead and the item is flagged `dateLocalTime`; if that is unusable too the item is flagged
  `dateMissing` and has no date.
- Only UTF-8 is accepted. A UTF-16 or UTF-32 byte order mark, a NUL byte before the root, or an XML declaration with
  another encoding gives `WXR_ENCODING`.
- Attributes count against the size limits (at most 64 attributes and 64 KB per tag), as do elements (a fixed cost
  each); an item may hold at most 50,000 comments. A meta value over 16 KB is dropped, not truncated.
- A UNC or device path (`\\host\share`, `\\?\...`) and any path under a folder that contains `.git` is refused for the
  export and the detail file. The detail file is created with owner-only permissions where the system supports it.
- Passwords of protected posts are never stored; only a flag is kept.

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

## Loader

`src/import/run.ts` orchestrates parse (WXR) -> convert (HTML to Lexical) -> write (Payload Local API). Modules:
`media.ts` (legacy uploads to Media), `comments.ts` (legacy comments), `qa.ts` (report), `manifest.ts` (rollback
manifest), `cli.ts` (command line).

```
cd apps/cms
# dry run (the default): reads the file and the database, writes nothing
npm run import:wxr -- --file D:\churchtimes-private\export.xml --uploads D:\churchtimes-private\uploads
# real run, against a SCRATCH database first
$env:IMPORT_MANIFEST_PATH = 'D:\churchtimes-private\manifests\run-1.json'
npm run import:wxr -- --file D:\churchtimes-private\export.xml --uploads D:\churchtimes-private\uploads --apply
```

Flags: `--file` (required), `--uploads <folder>` (the copied `wp-content/uploads`), `--manifest <path>` or
`IMPORT_MANIFEST_PATH`, `--apply` (write), `--update` (rewrite already imported articles), `--old-host a.test,b.test`
(extra old-site hosts; the hosts in the export's own header are always used), `--limit N` (first N posts, for trials).
Exit code 0 when clean, 1 when an article failed to convert or write, 2 for a usage or path error. Errors print one short
code (`IMPORT_USAGE`, `IMPORT_FILE_INSIDE_REPO`, `IMPORT_UPLOADS_INSIDE_REPO`, `IMPORT_MANIFEST_REQUIRED`,
`IMPORT_MANIFEST_INSIDE_REPO`, `IMPORT_MANIFEST_UNWRITABLE`, `IMPORT_TOO_MANY_FAILURES`, or a `WXR_*` code).

### What is imported

- Posts with status `publish` and no password. Everything else is counted, never written: password-protected posts
  (`passwordProtected`), other statuses (`status-draft`, ...), missing id, date or title.
- Article: title, slug (from `wp:post_name`; on a clash `-<wp id>` is added), excerpt (plain text), body (converted),
  first category (created when absent; none gives `uncategorised`), featured image (`_thumbnail_id`), byline (channel
  author display name), `publishedAt` (the GMT date), `legacyUrl`, `legacyId`, Rank Math / Yoast title and description
  (dropped when they hold `%variables%` or are over the length limits, C2). Imported articles are `published`.
- Approved ordinary comments through `toLegacyCommentData`, plus a second email-shaped-text pass over names and bodies
  (an address becomes `[email removed]`, a name with an at-sign becomes `Anonymous`). `parentLegacyId` is kept only
  when the parent is imported for the same article (loops are broken); otherwise the reply becomes top level.
- Images: article HTML addresses and `_wp_attached_file` are reduced to a path under `wp-content/uploads` and matched
  to `media.legacyPath` (exact path, then without a `-300x200` size suffix); when there is none the file is read from
  `--uploads` and created as Media (the Media rules apply: JPEG/PNG/WebP, alt text). Unresolved images become text in
  the body and are counted by reason: `missing-file`, `bad-path`, `outside-root`, `external-host`, `not-an-upload`,
  `no-uploads-root`, `not-a-file`, `too-large`, `rejected-by-media-rules`.

### Safety

- Its own context flag, `req.context.import` (server-side, a REST client cannot set it), not `seed`. The only thing it
  skips is the editorial workflow (`Articles.enforceWorkflow`); the Articles validators (embeds, body images, SEO
  fields, slug) stay on.
- Idempotent. An article is found by `legacyId`; by default an existing one is left alone (counted `unchanged`) and a
  second run changes nothing: no article, media, comment or audit row is written. `--update` rewrites the converted
  fields (not slug, category, status or date). Comments are completed for existing articles too (ids that exist are
  skipped), so an interrupted run can simply be repeated.
- Dry run writes nothing: no media, category, article, comment, audit row or manifest.
- One `import.article` audit row per article created or updated (summary `Imported legacy article <wp id> (created)`;
  no title or address). The ordinary `create` audit row of the Articles collection is written as well.
- Rollback manifest (`--apply` only): JSON of ids (articles created and updated, categories, media, comments, audit
  rows), no text. Created exclusively (`wx`) at the start of the run, so an existing or unwritable path stops the run
  before any database write; written with mode `0o600` (Windows ignores POSIX modes; keep the folder private); filled
  in as the run progresses and finally also after a failure. It must be outside the repository. There is no rollback
  command yet; the manifest is what one needs. An updated article's previous content is not kept in it (Payload keeps
  article versions).
- Files are read only from inside the real `--uploads` folder: UNC and device paths, drive letters, `..`, backslashes,
  alternate-stream colons, NUL and control characters are refused, and the real path (symlinks and junctions resolved)
  must stay inside the real uploads folder. Files over 25 MB are refused.
- 50 consecutive failed articles stop the run (`IMPORT_TOO_MANY_FAILURES`).

### QA report

Printed at the end (counts and reason codes only; no title, slug, address, file name, author name or comment text):
source items by kind, posts by status, published posts, approved comments on published posts, attachments; articles
created / updated / unchanged / skipped by reason / password-protected, and "published posts accounted for X of Y";
categories created and fallback use; media reused / created / unresolved by reason; images resolved and unresolved,
links unmapped, featured images missing, YouTube embeds, tables flattened, embeds dropped; comments created, already
present, skipped by reason, orphaned parents, truncated; and (apply only) the number of articles and comments now in
the database for the legacy ids seen. Unmapped-link and image counts are per occurrence.

### Not yet covered

A rollback command that reads the manifest; pages (`page` items are not imported); draft and private posts; tags;
authors as users; redirects (see `import:redirects`); a real 4,346-post export and the real uploads folder (the tests use
a small synthetic export).

### Tests

`tests/unit/importLoader.test.ts` (path confinement and refusals, comment cleaning and threading, manifest, report,
arguments) and `tests/integration/import-loader.test.ts` (a synthetic export imported twice against a real database:
dry run, first run, no-op second run, `--update`, manifest, audit rows, comments, media resolution, traversal refusal).

### Converter tests

`tests/unit/htmlToLexical.test.ts` (table-driven unit and adversarial cases), `tests/unit/htmlToLexicalCorpus.test.ts`
(48 synthetic articles from `tests/fixtures/html/corpus.ts`), `tests/unit/convertReport.test.ts` and
`tests/integration/import-lexical.test.ts` (converted bodies through the real REST handlers). All content is invented.
