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
- Video: YouTube stays a `youtubeEmbed` block; files hosted on the old site become `audioVideo` blocks (see the audio/video bullet below). The 11-character id is taken from `iframe` sources (`youtube.com/embed`,
  `youtube-nocookie.com/embed`, `youtu.be`, `watch?v=`, shorts), `[youtube ...]` and `[embed]` shortcodes, `wp:embed`
  blocks, old `object`/`embed` markup and bare YouTube URLs on their own line. Any other iframe/embed becomes a
  paragraph with the https link, or is dropped; always reported. `script`, `style`, `form`, `input`,
  `svg` and similar are dropped with their contents.
- Audio and video files (API contract v1.19): `<video>`, `<audio>` (with `src` or `<source>` children, preferring the first mp4/webm/mp3/m4a/ogg address) and the
  shortcodes `[fvplayer src=.. splash=.. caption=..]`, `[video mp4=.. poster=..]`, `[audio src=..]` become one `audioVideo` block each (`kind`, `media`, optional `poster`,
  `title`, `caption`). The title is the element title, else the caption, else the article title, else "Video"/"Audio". The file is found like an image: `media.legacyPath`, then the
  copied uploads folder (the Media rules check the bytes; the audio/video size cap is `MEDIA_AV_MAX_MB`, default 100 MB, not the 10 MB image cap). When the file cannot be found or
  is refused, the block is kept with the legacy address (`sourceUrl`) and the report counts it as `unresolved-media` (`content.avUnresolvedMedia`; the reason by code is in the media
  `unresolved` table). Counts only: no address or file name is printed. Types the CMS does not host (`.mov`, `.wav`, streams, other players) stay a link paragraph or are dropped
  (`content.avUnsupported`); a YouTube address in these tags still becomes a YouTube block. The new Media rows are in the rollback manifest like image media, so rollback needs no change.
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
$env:IMPORT_MANIFEST_PATH = 'D:\churchtimes-private\manifests\run-1.jsonl'
npm run import:wxr -- --file D:\churchtimes-private\export.xml --uploads D:\churchtimes-private\uploads --apply
```

Flags: `--file` (required), `--uploads <folder>` (the copied `wp-content/uploads`), `--manifest <path>` or
`IMPORT_MANIFEST_PATH`, `--apply` (write), `--update` (rewrite already imported articles that nobody edited since), `--force-update` (also those), `--old-host a.test,b.test`
(extra old-site hosts; the hosts in the export's own header are always used), `--limit N` (first N posts, for trials), `--category-map <json>` (tag to category map, outside the repository; see "Uncategorised posts"), `--fallback-category <slug>` and `--fallback-category-name <name>` (or `IMPORT_FALLBACK_CATEGORY`, `IMPORT_FALLBACK_CATEGORY_NAME`, `IMPORT_CATEGORY_MAP`; default `news` / `News`).
Exit code 0 when clean, 1 when an article failed to convert or write, 2 for a usage or path error. Errors print one short
code (`IMPORT_USAGE`, `IMPORT_FILE_INSIDE_REPO`, `IMPORT_FILE_UNREADABLE`, `IMPORT_UPLOADS_INSIDE_REPO`, `IMPORT_MANIFEST_REQUIRED`,
`IMPORT_MANIFEST_INSIDE_REPO`, `IMPORT_MANIFEST_UNWRITABLE`, `IMPORT_TOO_MANY_FAILURES`, or a `WXR_*` code).

### What is imported

- Posts with status `publish` and no password. Everything else is counted, never written: password-protected posts
  (`passwordProtected`), other statuses (`status-draft`, ...), missing id, date or title.
- Article: title, slug (from `wp:post_name`; on a clash `-<wp id>`, then a number, is added; every candidate is checked, and links between articles use the FINAL slug. Articles live at `/{slug}/` (owner decision D1), so a slug that equals a reserved route name such as `admin`, `api`, `search`, `category`, `newsletter` or `wp-json` (`src/lib/reservedSlugs.ts`) is never used: the post gets the `-<wp id>` form and the report line "slug is a reserved route name, renamed with the post id" counts it). Because the new address equals the WordPress address, an imported post with an unchanged slug needs NO redirect rule; rewritten internal links use `/{slug}/`, excerpt (plain text), body (converted),
  ONE category (see "Categories and authors" below), featured image (`_thumbnail_id`), byline text (see below), `publishedAt` (the GMT date), `legacyUrl` (the old permalink, see below), `legacyId`, Rank Math / Yoast title and description
  (variables resolved, then cut to the length limits, C2; see "SEO text"). Imported articles are `published`.
- Approved ordinary comments through `toLegacyCommentData`, plus a second email-shaped-text pass over names and bodies
  (an address becomes `[email removed]`, a name with an at-sign becomes `Anonymous`; a byline that is an email address is dropped). `parentLegacyId` is kept only
  when the parent is imported for the same article (loops are broken); otherwise the reply becomes top level.
- Images: article HTML addresses and `_wp_attached_file` are reduced to a path under `wp-content/uploads` and matched
  to `media.legacyPath` (exact path, then without a `-300x200` size suffix); when there is none the file is read from
  `--uploads` and created as Media (the Media rules apply: JPEG/PNG/WebP, alt text). Unresolved images become text in
  the body and are counted by reason: `missing-file`, `bad-path`, `outside-root`, `external-host`, `not-an-upload`,
  `no-uploads-root`, `not-a-file`, `too-large`, `rejected-by-media-rules`, `rejected-unsafe` (see "Checking the uploads folder" below).

### Safety

- Its own context flag, `req.context.import` (server-side, a REST client cannot set it), not `seed`. The only thing it
  skips is the editorial workflow (`Articles.enforceWorkflow`); the Articles validators (embeds, body images, SEO
  fields, slug) stay on.
- `articles.legacyId` and `legacyUrl` are server-owned (field access `create: never, update: never`; only the Local API of the importer writes them) and `legacyId` is UNIQUE (migration `20261021_100000_article_legacy_id_unique`, which refuses to run while duplicates exist). More than one match for a legacy id fails that post (`duplicate-legacy-id`), it never picks the first.
- One database transaction per post (article, categories, media rows, comments, audit rows): a failure leaves nothing of that post. Uploaded files already copied to the media folder stay on disk as orphans.
- Idempotent. An article is found by `legacyId`; by default an existing one is left alone (counted `unchanged`) and a
  second run changes nothing: no article, media, comment or audit row is written. `--update` rewrites the converted
  fields (not slug, category, status or date) but skips an article edited after its last `import.article` audit row (`edited-since-import`; one with no such row counts as edited) unless `--force-update`. Comments are completed for existing articles too (ids that exist are
  skipped), so an interrupted run can simply be repeated.
- Dry run writes nothing: no media, category, article, comment, audit row or manifest.
- One `import.article` audit row per article created or updated (actorRole `import`, status taken from the saved article, summary `Imported legacy article <wp id> (created)`;
  no title or address). The ordinary `create` (Articles) and `upload` (Media) audit rows are written too, with `import` as actor role.
- Rollback manifest (`--apply` only): an append-only JSON Lines file of ids (no text), written outside the repository with
  mode `0o600` (Windows ignores POSIX modes; keep the folder private). It is created exclusively (`wx`) after the export
  file has opened and before any database write, and every line is fsynced as it is written: `intent` (before a post is
  touched), `id` (articles created or updated, categories, media, comments, and the `import.article`, Articles `create`
  and Media `upload` audit rows, right after each is created), `commit` or `abort` (end of the post's transaction) and
  `end`. A kill loses at most the line being written; `readManifest` (manifest.ts) skips a torn last line and reports
  `openIntents` (a post that was in flight). An id logged in a transaction that never committed does not exist in the
  database, and rolling back a missing id is harmless. Rollback reads this file (see "Rehearsal and rollback"). An updated article's previous
  content is not kept in it (Payload keeps article versions).
- SIGINT and SIGTERM stop the run between posts: the post in flight finishes, the manifest gets its `end` line and the
  report is printed (exit code 1).
- Files are read only from inside the real `--uploads` folder: UNC and device paths, drive letters, `..`, backslashes,
  alternate-stream colons, NUL and control characters are refused, and the real path (symlinks and junctions resolved)
  must stay inside the real uploads folder. Image files over 10 MB (the Media collection's image cap, `MAX_IMAGE_BYTES`) and audio/video files over `MEDIA_AV_MAX_MB` are refused.
- 50 consecutive failed writes, or (after 20 posts) more than half failing, stop the run (`IMPORT_TOO_MANY_FAILURES`). Report keys for post statuses come from a fixed set (anything else is `other`).

### SEO text

`Articles.seoTitle` (70) and `seoDescription` (200) are filled per field: an explicit Rank Math value first, else Yoast
(`_yoast_wpseo_title`, `_yoast_wpseo_metadesc`), else empty. Every value is untrusted text: markup is stripped, entities are
decoded (never into `<` or `>`), whitespace is collapsed.

- **Variables.** Yoast `%%var%%` and Rank Math `%var%` are resolved with fixed rules: `title` (the post title), `sitename`
  (`Church Times Nigeria`), `sep` (`-`), `page` (empty), `category` / `primary_category` (the post's category name),
  `date` (for example `4 May 2023`), `excerpt` / `excerpt_only`. Any other variable (`%%name%%`, `%%sitedesc%%`,
  `%%cf_x%%`, `%var(arg)%`) is removed and the separators it leaves are tidied. A value that still contains `%%` or a `%var%`
  afterwards is dropped (counted as `droppedUnresolved`) and the next source is tried. Regexes are bounded; values over 20,000
  characters are dropped.
- **Length.** Over the limit, a trailing `- Church Times Nigeria` is removed first (the public site adds its own), then the text is
  cut at a word with an ellipsis (counted as `truncated`).
- **Not stored (no field in C2):** `_yoast_wpseo_canonical` (counted valid when https, a path, or http on a site host, else invalid),
  `_yoast_wpseo_meta-robots-noindex` (counted when `1`) and the Open Graph / Twitter title and description (counted). The report
  line "Yoast values with no field in the schema" sizes them so the owner can ask for a contract change (canonical, noindex) if wanted.
- The report (`SEO text` section) gives counts by source (Rank Math, Yoast, none) for title and description, values with variables
  resolved, dropped, truncated. SEO values are written for articles created or updated in the run; `--update` rewrites them.

### Uncategorised posts

`Articles.category` is one required relationship, so each NEW article gets one category by this deterministic chain (the first
step that applies):

1. the post's WordPress categories (the existing rule above);
2. the Yoast primary category (`_yoast_wpseo_primary_category`, a term id) when it is a category listed in the export's channel
   (`wp:category`, matched by `wp:term_id`); the generic `uncategorised` never counts as a placement;
3. the first WordPress TAG that has an entry in the `--category-map` file, a JSON object of tag slug to category slug
   (`{"church-life": "faith"}`), outside the repository, at most 10,000 entries, slugs only. The target must be a category of the export,
   or already exist in Categories; otherwise it is counted (`tagMapTargetMissing`) and the chain continues. Categories are NEVER
   created from tags. Without the file, tags are skipped;
4. the generic WordPress `uncategorised` category if the post had exactly that (unchanged behaviour), else the fallback category
   (`--fallback-category`, default slug `news`, title `News`; found by slug, created if missing and recorded in the manifest like any
   other created category, so rollback removes it when nothing uses it).

Counts per step are in the report (`category source`, `Yoast primary category not in the export`). Only new articles get a category;
an existing article is never recategorised, so a second run changes nothing (idempotent) and rollback is unchanged.

Real export measured (2026-10-13 file, published posts): 3,050 have no WordPress category; 1,973 posts carry a Yoast primary category and
for 1,658 of the uncategorised ones it resolves to one of 8 exported categories; the file has 1 post with a tag and 1 distinct tag, so the
tag step has nothing to work with and needs no map; the other 1,392 uncategorised posts (310 with a primary id that is not in the export,
the rest with none) land in the fallback category.

### Categories and authors

- **One category per article.** `Articles.category` is a single REQUIRED relationship and there is no second categories field, so
  only one WordPress category per post can be kept. The primary is the first listed category, except that WordPress's generic
  `uncategorised` / `uncategorized` is skipped when a real category exists; a post with none follows the chain in "Uncategorised posts".
  Posts that had more are counted (`postsWithExtraCategories`, `extraCategoriesDropped`) so the owner can decide whether a
  schema change (a `categories` hasMany field plus a migration) is wanted before the real run. Only the kept category is created,
  and it is recorded in the manifest, so rollback is unchanged (it removes created categories that no article still uses).
- **Authors without accounts.** `wp:creator` becomes `bylineName` TEXT only: the channel display name, else the creator login. A name that is
  or contains an email address becomes empty. No user is ever created or matched and `author` is left empty. The report
  gives counts only: distinct authors, how many got a byline, how many had no usable name (unmapped) and posts left without a byline.
  A login such as `admin` is used as written when there is no display name; check the `unmapped` and distinct counts on the dry run.
- **`legacyUrl`.** The old permalink (`<link>`), as a same-site path (`/2023/05/story/`) or an http(s) URL, with the query string and fragment removed.
  Refused (field left empty): other schemes, protocol-relative `//host`, credentials in the URL, spaces, control characters, backslashes, quotes,
  angle brackets, over 1000 characters, or nothing left but the site root (for example `?p=123` links). The field is server-owned; only the importer writes it.

### `npm run import:inspect` (sizing, read-only)

```
cd apps/cms
npm run import:inspect -- --file D:churchtimes-privateexport.xml
```

Reads the export only: no database, no network, no writes; a path inside the repository is refused. Output is counts only: posts by
status, published password-protected posts, categories (in the file, used by posts, posts with more than one), tags and Yoast data on published posts (posts with tags, distinct tags, Yoast title / description / canonical / noindex / social counts, primary category and how many resolve, uncategorised posts a primary category or tag would place), distinct authors
(a number, no names), comments by status (approved, pending, spam, trash, other), attachments, the top 20 shortcode tag names
(the only strings taken from the file), the largest post content in bytes, and the deepest HTML element nesting in post content.
Run it first to size the real import; `import:wxr-report` has the wider parse report.

### QA report

Printed at the end (counts and reason codes only; no title, slug, address, file name, author name or comment text):
source items by kind, posts by status, published posts, approved comments on published posts, attachments; articles
created / updated / unchanged / skipped by reason / password-protected, and "published posts accounted for X of Y";
categories created, fallback use and the extra categories the schema cannot hold; authors (distinct, with a byline, unmapped, posts without a byline: counts only); media reused / created / unresolved by reason; images resolved and unresolved,
links unmapped, featured images missing, YouTube embeds, tables flattened, embeds dropped; comments created, already
present, skipped by reason, orphaned parents, truncated; and (apply only) the number of articles and comments now in
the database for the legacy ids seen. Unmapped-link and image counts are per occurrence.

### Not yet covered

Pages (`page` items are not imported); draft and private posts; tags;
authors as user accounts (never created, by design); more than one category per article (the schema has one); redirects (see `import:redirects`); a real 4,346-post export and the real uploads folder (the tests use
a small synthetic export).

### Tests

`tests/unit/importLoader.test.ts` (path confinement and refusals, comment cleaning and threading, manifest, report,
arguments) and `tests/integration/import-loader.test.ts` (a synthetic export imported twice against a real database:
dry run, first run, no-op second run, `--update`, manifest, audit rows, comments, media resolution, traversal refusal).

### Converter tests

`tests/unit/htmlToLexical.test.ts` (table-driven unit and adversarial cases), `tests/unit/htmlToLexicalCorpus.test.ts`
(48 synthetic articles from `tests/fixtures/html/corpus.ts`), `tests/unit/convertReport.test.ts` and
`tests/integration/import-lexical.test.ts` (converted bodies through the real REST handlers). All content is invented.

## Archive candidates (recovered pages, draft only)

### `npm run import:archive-candidates -- --file <candidates.jsonl> [--apply] [--manifest <dir>] [--category <slug>] [--batch <label>]`

Imports pages recovered from web captures (format `archive-candidate/1`, fully specified in `docs/archive-candidate-schema.md`) as
**draft** articles with provenance. Nothing recovered is ever published automatically (`src/import/archiveCandidates.ts`).

- **Dry run by default.** It reads the file and the database and writes nothing (no articles, no category, no manifest). `--apply`
  writes and needs `--manifest <existing directory>`: the rollback manifest (`archive-candidates-<batch>-<time>.manifest.jsonl`) and
  the per-row detail file (`...detail.jsonl`: row number and a fixed outcome code, never text) are created there, mode 0600, never
  overwritten. The source file and the directory must be **outside every Git work tree** (`ARCHIVE_FILE_INSIDE_REPO`,
  `ARCHIVE_MANIFEST_INSIDE_REPO`). A dry run with `--manifest` also writes the detail file.
- **Validation per line**: schema version, strict keys, sizes, plain-text fields, http and https addresses only, host equals the
  address's host, real calendar dates, hashes, `confidence` one of `partial`, `citation-only`, `missing` (`verified-full` is refused),
  no script content in the body. The body then goes through the same sanitising HTML-to-Lexical converter as the WordPress import
  (`req.context.import = true`: editorial workflow skipped, embed, image, SEO and slug validators on). Images are not imported by
  this command: media references are validated and counted only; unresolved images are dropped from the body.
- **Deduplication** (each counted, nothing written): a second line in the file with the same address or `rawSha256`
  (`duplicateInFile`); an article that already has the same `provenance.sourceUrl` (also `http` or `https`, with or without `www.`
  and a trailing slash), the same `provenance.sourceSha256`, or a WordPress `legacyUrl` equal to the address (`alreadyPresent`:
  `present-source-url`, `present-source-hash`, `present-legacy-url`); and the same slug with the same normalised title
  (`present-slug-title`). A slug owned by a **different** article, or equal to a reserved route name (`src/lib/reservedSlugs.ts`),
  gets `-archive`, `-archive-2` and so on (`slugRenamed`, `slugRenamedReserved`).
- **Idempotent**: a second run over the same file creates nothing (every line is `present-source-url`).
- **Result**: `status: draft`, no `publishedAt`, `provenance.reviewStatus: pending`, `provenance.importBatch` (`arc-` plus 12 hex
  characters of the file hash, or `--batch`), the category given by `--category` (default `uncategorised`, created on apply when missing
  and recorded in the manifest), one `import.article` audit row per draft. One database transaction per line.
- **Publishing is gated**: an article with an `importBatch` cannot be set to `published` or `scheduled` (409) until an editor sets
  `provenance.reviewStatus` to `reviewed` in the admin. The rule runs server-side in the Articles `beforeChange` hook for every caller
  (REST, admin, scheduler, seed, importer). Only `reviewStatus` is editable (editors); the other provenance fields are server-owned.
- **Never public**: the `provenance` group has staff-only read access, so it is absent from every anonymous response, including
  published articles; the drafts themselves are invisible to anonymous reads.
- **Rollback**: the manifest is compatible with `import:rollback` (below). An imported article is recognised by its `importBatch`
  (as a WordPress import article is by its legacy id); an article an editor has touched since (including flipping the review status)
  is skipped as `edited-since-import` unless `--force`.
- **Output** is counts only: lines, invalid by reason, duplicates, already present, drafts created (or that would be), by confidence,
  failed by fixed code. Exit codes: 0 success, 1 some lines failed to write or the run was stopped, 2 usage or safety refusal.
  A rejected line never prints its content. 20 failed writes in a row abort the run (`ARCHIVE_TOO_MANY_FAILURES`).
- Tests: `tests/unit/archiveCandidate.test.ts` (validator edge cases, publish guard, arguments) and
  `tests/integration/archive-candidates.test.ts` (draft created, never public, publish blocked until reviewed, dedup, idempotence,
  slug collisions, rollback). Fixtures are synthetic (`tests/fixtures/archive/candidates.ts`).

## Rehearsal and rollback

### `npm run import:rollback -- --manifest <path> [--apply] [--force [--include-published]] [--allow-incomplete]`

Undoes ONE import run from its manifest (`src/import/rollback.ts`). A DRY RUN unless `--apply`.

- Deletes only ids the manifest lists as CREATED by that run, and only when the row proves it: legacy comments (with a legacy id), articles (with a legacy id, or a provenance import batch for archive candidates), media
  documents (with a legacy path) and their files, and categories. Every row must also have been created inside the run's time window (`createdAt` between the
  manifest's start line, minus 5 seconds, and its end line, or for a killed run the last manifest write); anything else is skipped
  (`outside-run-window`, `not-an-imported-row`). Only `created` id lines count: `updated` lines for any kind are ignored, and articles the run only updated are never touched
  (`articlesUpdatedNotReverted`; Payload keeps their earlier versions).
  Audit rows are KEPT (they are the record of what happened); one `import.rollback` audit row (counts only) is added. Each row that is deleted also writes
  the collection's own `delete` audit row (Articles and Media include the title or file name in its summary, as for any staff deletion).
- Refuses (exit 2, one code) when the manifest is missing or unreadable (`ROLLBACK_MANIFEST_UNREADABLE`), is not a manifest (`ROLLBACK_MANIFEST_INVALID`)
  or has no `end` line, meaning the run was killed (`ROLLBACK_MANIFEST_INCOMPLETE`), unless `--allow-incomplete`; even then a manifest written to in the last 60 seconds is
  refused (`ROLLBACK_MANIFEST_TOO_RECENT`, the run may still be going). The ids logged for the post in flight (`openIntents`) are included like any other; a post whose
  transaction never committed left no rows, so its ids are simply "already gone". Nothing is ever looked up by legacy id: only ids written in the manifest are deleted.
  `--apply` needs `--manifest` on the command line (no `IMPORT_MANIFEST_PATH` fallback); the report prints the manifest's start time so you can see you picked the right file.
- Skips a row changed after it was created (`updatedAt` more than a second after `createdAt`: staff edited it, or a later `--update` run rewrote it): `edited-since-import`.
  `--force` deletes those too, except an article that is published or whose `provenance.reviewStatus` is `reviewed` (`published-or-reviewed`): those need the separate explicit flag `--include-published` as well (it only widens `--force`: `--include-published` without `--force` is refused, exit 2). Nothing else is overridden. After an `--update` run, rolling back the FIRST manifest therefore needs `--force`.
- Skips rows something else still needs, never deleting them: an article with comments that are not being deleted (`has-remaining-comments`),
  media used by an article, a live update, or ANY creative field of ANY placement of an ad campaign, a category used by an article, live event or user (`still-used`), and a media
  file name that is not a plain name (no separator, drive or stream colon, control character or leading dot; spaces, non-ASCII and a leading underscore are fine) inside
  the media folder (`unsafe-file-name`, not overridden by `--force`). Dependants go first: comments, articles, media, categories.
- Deleting an article or media row silently clears references that are not checked: older article versions (`featuredImage`), submissions that point at the article, and redirects.
  Neither is expected for a freshly imported article; look at the dry run if staff used the site in between.
- Ids already gone are counted (`alreadyGone`), so a second rollback changes nothing. One database transaction per item; a failed item is counted
  (`failed`, exit 1) and the rest continue.
- Output is counts and fixed codes only: listed, deleted (or would delete), already gone, skipped by reason, failed, per kind.
- Accepted limit: Payload removes a media file together with its document, before the row is deleted. An item that fails afterwards can leave a document whose file is gone; run the rollback again.

### `npm run import:rehearse -- [--posts 1000] [--images 60] [--seed N] [--keep]`

A full rehearsal on a throwaway embedded PostgreSQL (free port, temp data directory, removed at the end) with a LARGE SYNTHETIC export written to a temp
folder outside the repository (`tests/fixtures/wxr/large.ts`: images, captions, galleries, embeds, unknown shortcodes, 8-deep nested blocks, entities, scripts and
iframes, tables, password and draft posts, duplicate and non-ASCII slugs, no slug, threaded comments, spam, email-shaped text). It runs: dry run,
apply, second apply (must change nothing), update, rollback (dry, apply, again). It prints counts, per-phase seconds, posts per second, database
queries and peak memory, then PASS/FAIL checks (exit 1 on any FAIL). Its media folder is inside the temp folder (the real one is never touched), and Ctrl+C stops PostgreSQL and removes the temp folder. No real data is read.

Reference run on a Windows laptop, 1,000 posts (957 importable, 1,905 comments, 60 images): dry run 14 s, apply 113 s (9 posts/s, about 26 queries per article), second apply 17 s,
update 86 s, rollback 35 s; peak RSS about 430 MB for the whole process (Payload included). Time scales linearly: a 4,346-post export is roughly 8 minutes to apply.

`tests/integration/import-process-signal.test.ts` starts the real command (`payload run src/seed/importWxr.ts -- ...`) against a large synthetic export and stops it
part-way: a real SIGINT on Linux and macOS (the post in flight finishes, the manifest ends with status `stopped`, exit 1), and on Windows a hard kill, because Node cannot
send SIGINT to another process there (it terminates it with no handler) and a console Ctrl+C cannot be sent to a detached child without a native addon. A hard kill is the
harder case: no `end` line, possibly a torn last line. In both, the manifest stays readable and `import:rollback --allow-incomplete` removes what the run wrote, twice.
`payload run` parses flags itself, so the npm scripts end with `--` (without it `--file` never reaches the importer and the run stops with `IMPORT_USAGE`);
calling `payload run` by hand needs the same `--` before `--file`.

### Owner runbook

Use folders OUTSIDE the repository. Replace the example paths.

```
cd apps/cms
# 0. Use a scratch database first (never staging or production). Check that DATABASE_URL points at it.
# 1. Rehearse the tooling on synthetic data (no real files involved)
npm run import:rehearse
# 2. Dry run on the real export: writes nothing
npm run import:wxr -- --file D:\churchtimes-private\export.xml --uploads D:\churchtimes-private\uploads
# 3. Apply. The manifest must not exist yet. Keep it: it is the only way to undo this run
npm run import:wxr -- --file D:\churchtimes-private\export.xml --uploads D:\churchtimes-private\uploads --apply --manifest D:\churchtimes-private\manifests\run-1.jsonl
# 4. QA report: the counts printed at the end ("published posts accounted for X of Y", failures, unresolved images),
#    then open a sample of articles in the admin. Repeat step 3 with a new manifest name to prove it is a no-op ("unchanged", no new ids).
# 5. Rollback, only if the result is not accepted. Dry run first and read the counts, then apply:
npm run import:rollback -- --manifest D:\churchtimes-private\manifests\run-1.jsonl
npm run import:rollback -- --manifest D:\churchtimes-private\manifests\run-1.jsonl --apply
# A killed run (no end line): add --allow-incomplete. Rows staff edited since (or that --update rewrote): add --force, after reading the dry run.
```

A rollback does not remove audit rows (kept on purpose), does not restore an article that `--update` rewrote (use its version history), and touches
nothing the manifest does not list.

## Importing on the server (production compose)

The production stack mounts no export, uploads or manifest folder, so the import uses the opt-in override `docker-compose.import.yml` (service `importer`, profile `import`, never started by `up`). It runs the `importer` image (Dockerfile target `importer`: the migrator image plus `scripts/`, so `tsx`, `payload` and every `npm run import:*` command work) with the same hardening as `migrate`: uid 1000, read-only root, tmpfs `/tmp`, `cap_drop: ALL`, `no-new-privileges`, only the internal `db` network, no published ports.

Mounts (host paths come from variables with **no defaults**; keep all of them outside the repository checkout):

| Variable | Container path | Mode |
| --- | --- | --- |
| `IMPORT_EXPORT_FILE` (a file) | `/import/export.xml` | read-only |
| `IMPORT_UPLOADS_DIR` | `/import/uploads` | read-only |
| `IMPORT_PRIVATE_DIR` (owned by 1000:1000, mode 700) | `/import/private` | read-write: manifests and reports |
| `CMS_MEDIA_DIR` (default `/srv/churchtimes/media`) | `/app/media` | read-write: ingested images land here |

Build and pin the image from the same commit as the others (`docker build --target importer -t churchtimes-cms-importer apps/cms`), then:

```sh
export CMS_IMAGE=... CMS_MIGRATOR_IMAGE=... CMS_IMPORTER_IMAGE=ghcr.io/abcentech/churchtimes-cms-importer@sha256:<digest>
export IMPORT_EXPORT_FILE=/srv/churchtimes-private/export.xml
export IMPORT_UPLOADS_DIR=/srv/churchtimes-private/uploads
export IMPORT_PRIVATE_DIR=/srv/churchtimes-private/import-private
C="sudo -E docker compose -f docker-compose.production.yml -f docker-compose.import.yml --profile import run --rm importer"
sudo -E docker compose -f docker-compose.production.yml up -d postgres
sudo -E docker compose -f docker-compose.production.yml --profile ops run --rm migrate      # schema first

$C                                                       # smoke: read-only uploads check on the mounts, counts only
$C npm run import:uploads-check -- --uploads /import/uploads --wxr /import/export.xml --out /import/private/uploads-detail.jsonl
$C npm run import:wxr -- --file /import/export.xml --uploads /import/uploads                       # dry run (default), writes nothing
$C npm run import:wxr -- --file /import/export.xml --uploads /import/uploads --apply --manifest /import/private/run-1.jsonl
$C npm run search:reindex                                                                           # after every apply: rebuild the search index (safe to repeat)
$C npm run import:rollback -- --manifest /import/private/run-1.jsonl                               # rollback dry run, read the counts
$C npm run import:rollback -- --manifest /import/private/run-1.jsonl --apply
```

Other commands (`import:inspect`, `import:wxr-report`, `import:convert-wxr`) take the same `/import/...` paths. The manifest must not exist yet; keep it, it is the only way to undo a run. Rollback needs the same `IMPORT_PRIVATE_DIR`. After every successful apply, run `npm run search:reindex` (the command above) so the public search finds the imported articles, and then start `cms`. Run it again after a rollback, which also changes the articles. Do the first import against a scratch database (`DATABASE_URL` in the env file), never the live one.

## Rehearsal against a real export

Run the whole import against the owner's REAL WordPress export on a throwaway database, with counts only on screen. Nothing real is written
anywhere except the folders you name: PostgreSQL is an embedded, temporary instance on a free port, the media folder is inside the temp
folder (never `apps/cms/media`), and everything is removed at the end (also on Ctrl+C). The export and the uploads folder are only read.

```
cd apps/cms
# Everything below stays OUTSIDE every repository. Replace the paths.
# 1. Dry run only (inspect stats, conversion stats, loader dry run). About 3 to 5 minutes for a 100 MB export.
npm run import:rehearse -- --file D:\churchtimes-private\export.xml --dry-run-only --detail-file D:\churchtimes-private\reports\rehearse-detail.json
# 2. Full rehearsal: also apply, second apply (must change nothing) and rollback, all on the throwaway database.
npm run import:rehearse -- --file D:\churchtimes-private\export.xml --uploads D:\churchtimes-private\uploads --detail-file D:\churchtimes-private\reports\rehearse-detail-2.json --uploads-detail-file D:\churchtimes-private\reports\uploads-detail.jsonl
# Conversion statistics alone (no database at all):
npm run import:convert-wxr -- --file D:\churchtimes-private\export.xml --detail-file D:\churchtimes-private\reports\convert-detail.json
```

Options: `--file` (required, outside every repository), `--uploads <dir>` (a copy of `wp-content/uploads`; it is checked first, see "Checking the uploads folder"), `--uploads-detail-file <path>` (per-file detail of that check, same rules as `--detail-file`), `--dry-run-only`, `--detail-file <path>` (must not exist yet,
outside every repository, owner-only permissions) and `--keep` (keep the temp folder for debugging; it holds the throwaway database and, after an apply, copied media).
A failed article write is reported as one line of error class, SQLSTATE and invalid field names (never values); its post id goes to the detail file (`applyFailed`). Exit code 0 only when every PASS/FAIL check passes and nothing failed to convert.

What is printed (counts and fixed codes only; the only strings taken from the file are shortcode, element and block tag names, and the fixed reason codes of the link rewriter):

- **Inspect**: posts by status, password-protected posts, categories, authors, comments by status, attachments, top shortcode tags, largest post, deepest HTML nesting.
- **Conversion of published posts**: each published post goes through `htmlToLexical` with no database.
  - *conversion failures by code*: `input-too-large` (over the 5 MB cap), `too-deep`, `too-many-nodes`, `invalid-output`. Any non-zero count needs a look.
  - *shortcodes removed by tag*: markers removed from the text. An opening and a closing tag count separately (`[caption]...[/caption]` is 2). Shortcodes that carry content the CMS cannot
    show (`video`, `audio`, `fvplayer`, `gallery`) are listed here: that content is NOT imported (only YouTube is kept), so each count is a post the editors should check.
  - *unknown elements*, *unknown blocks*, *elements dropped with contents*: markup the converter flattened to text or dropped. `pre` is kept as plain lines.
  - *tables kept / flattened*, *embeds linked / dropped*, *youtube blocks written*.
  - *images resolved / unresolved*: without `--uploads` every body image is unresolved (it becomes text). That is expected, not a failure. With `--uploads`, an unresolved image is a file missing from the folder.
  - *links*: rewritten to new article paths; kept as written but unmapped, by reason (`not a single-segment article address` is a category, tag, date or media link on the old host,
    which the public host redirects; `slug is not in the slug map` is an old-host link to a post that is not imported); turned into text, by reason (`tel:` links, links without a leading slash, and so on: the words stay, the link goes).
  - *deep nesting flattened* (past 64 levels), *lists flattened* (a list inside a quote or past 6 levels keeps its text as plain lines), *posts over the input cap*, *posts with converter warnings*.
  - *posts whose text shrank by more than 20%*: a data-loss signal. The non-space characters of the visible source text (tags, comments, scripts and shortcode markers removed; a bare YouTube address does not count, it becomes an embed)
    are compared with the non-space characters in the converted text. Expect 0. The legacy ids go to `--detail-file` (`textShrink`), never to the screen.
  - *posts with text in the source and none in the output*: the same signal at its sharpest (`emptyOutput` in the detail file).
- **Loader dry run** (the `import:wxr` report): published posts accounted for X of Y (difference must be 0), skipped by reason, (`empty-body`: a post whose body is empty after conversion, for example only an image that could not be resolved; the editor refuses an empty body, so the post is reported and not written; look at these in the old site), categories, authors, media (`unresolved by reason`, expected without `--uploads`),
  content counts, comments created / skipped by reason.
- **Apply, second apply, rollback** (not with `--dry-run-only`): apply must match the dry run and be verified in the database; the second apply must create nothing (`second apply changed nothing`);
  the rollback must remove every created row and its files, and its dry run must match it. Phase times, query counts and peak memory follow, then PASS/FAIL lines.

The detail file is JSON: `textShrink`, `emptyOutput`, `failed` (id and code), `inputOverCap`, `maxDepthHit` and `applyFailed`, all WordPress post ids. Open a post by id in the old WordPress admin to look at it. Do not paste the file, or what is in it, anywhere shared.

## Links in article bodies (`npm run import:link-audit`)

Every link in a body is classified by one shared module (`src/import/linkClassify.ts`); the converter rewrites with it and the audit counts with it.
The article path is `PUBLIC_ARTICLE_PATH_TEMPLATE` (`/{slug}/` by default (D1), `/reports/{slug}/` is the only other accepted value; the audit takes `--article-path` to override). A rewrite is always a root-relative
path on the site itself, never another host. Old hosts are the export's own site address plus `churchtimesnigeria.net`, `.org` and `.com`.

| Link type | Rule |
|---|---|
| article (`/{slug}/`, `/YYYY/MM/{slug}/`, `?p=N`) on an old host or root-relative | rewritten to the article path when the post is imported (slug through the FINAL slug map, `?p=N` through `wp:post_id`) |
| article whose post is a draft, private, password-protected or not imported; slug or id not in the export | kept as written, reported (`article is not published or not imported`, `slug is not in the slug map`, `post id is not in the export`) |
| home | rewritten to `/` |
| category archive (`/category/a/b/`, `?cat=N`) | rewritten to `/category/{leaf}/` when the import creates that category (it is some article's category); else kept, reported. Nested old paths get an exact 301 rule |
| tag archive | kept, reported: the CMS has no tag pages. `--tag-path` can name a target when the public host has one |
| page (`wp:post_type` page, `?page_id=N`) | kept, reported: there is no pages collection yet |
| attachment page, author, date archive, feed, search, WordPress admin | kept, reported (nothing to point at) |
| `wp-content/uploads` file | kept, reported; rewritten only when the media map can carry it (hook `uploadPath`, not wired yet) |
| `mailto:` | unchanged. `tel:` and other schemes: unchanged (the words stay, the link goes) |
| external site | unchanged, not counted as a site link |

The command is read-only (no database). From `apps/cms`:

```
npm run import:link-audit -- --file <export.xml> [--out <rows.jsonl>] [--redirects-out <rules.csv>] [--article-path '/{slug}/'] [--category-path '/category/{slug}/'] [--tag-path '/tag/{slug}/'] [--old-host a.test]
```

It prints counts only (types, resolved, unresolved, resolved before this change, unresolved reasons, redirect rules and what was dropped). `--out` (one JSON line per link, addresses
included) and `--redirects-out` must be outside every git work tree; a path inside one is refused (exit 2). `--redirects-out` writes exact-match 301 rules in the
`import:redirects` format (`from,to,status`) for nested category and tag archives and dated permalinks (a dated permalink that is the post's own permalink is already an
article rule and is dropped). Rules are canonical, identical ones are dropped, one target per address, chains are flattened, loops and conflicts are dropped, no 410 is ever invented.
`?p=N` cannot be an exact rule (a rule cannot carry a query string); the public host resolves it through `legacyId`, and the body links are already rewritten.
Anchors that wrap an image (a lightbox link to the full-size file) are counted separately: the converter keeps the image, not the link.

Real export (`2026-10-13`, published posts, counts only; "before" means resolved by the rewriter before this change):

| Type | Total | Resolved | Unresolved | Resolved before |
|---|---|---|---|---|
| article (plain slug) | 501 | 501 | 0 | 501 |
| home | 29 | 29 | 0 | 29 |
| article, slug not in the export | 16 | 0 | 16 | 0 |
| uploads file | 3119 (3105 wrap an image) | 0 | 3119 | 0 |
| other path (2 or 3 segments) | 6 | 0 | 6 | 0 |
| category, tag, page, attachment, author, date archive, `?p=N`, `?page_id=N`, feed, admin | 0 | 0 | 0 | 0 |
| mailto / tel / other scheme / anchor / no leading slash / external | 135 / 107 / 3 / 18 / 41 / 3532 | not site links | | |

One link is on `churchtimesnigeria.org` or `.com` (its slug is not in the export, so it stays unresolved). Resolved links are the same before and after (530): this export has none of the
newly handled types. The converter, which counts links after image anchors and nesting are resolved, rewrites 549 (548 in the previous rehearsal) and keeps 419 unmapped (397 uploaded files, 16 unknown slugs, 6 other paths). The export has no category, tag, page, author, date, `?p=N` or feed links, so the
redirect file is empty (header only) for this export. Run the audit again after every re-export.

What is left, and who does it:

- **Owner**: decide what the 16 links to slugs that are not in the export should do (remove the link, or point at a replacement), and the 6 other paths. Details are in the private rows file (`--out`).
- **Owner**: nothing to set for the default: `/{slug}/` (D1) is the built-in default of the importer and the CMS. Set `PUBLIC_ARTICLE_PATH_TEMPLATE=/reports/{slug}/` only to override it, on the CMS and the public host alike (the importer used to write `/article/{slug}`).
- **Owner**: `churchtimesnigeria.org` and `.com` must reach the same public host (DNS or host-level redirect) and be listed in `LEGACY_SITE_HOSTS`; path rules do not carry a host.
- **Codex (E3, old-host redirect map)**: covered on the CMS side for exact rules by `--redirects-out`; still the public host's job: pattern rules (`/category/*`, `/tag/*`, `/page/N/`, `/feed/`), `?p=N` through `legacyId`, the `/category/{slug}/` route itself (the CMS only emits and rewrites to that form; change it with `--category-path`), and tag pages if wanted.
- **Codex (E4, link audit)**: covered on the CMS side by this command (read-only, counts, private rows). Still open: the 3119 uploads links (they need the media map, `export:media-map`, to resolve) and pages (a pages collection, then `pagePath`).
- **Import**: `npm run import:redirects -- --file <rules.csv>` (dry run first) after the articles are imported.

## Categories: the rules mode (`--category-mode=rules`)

**Default is `strict`** (the behaviour before this existed): WordPress category, Yoast primary category, tag map, generic "Uncategorised", fallback category. `--category-mode=rules` is opt-in and awaits the owner's approval before it becomes the default. In rules mode a classifier runs only for posts the earlier steps could not place; it never overrides a WordPress or Yoast category or a tag-map entry.

Options: `--category-mode=strict|rules`, `--category-rules <rules.json outside the repo>` (replaces the built-in rules), `--category-review <csv outside the repo, must not exist>`, `--fallback-category <slug>` and `--fallback-category-name <name>` (default `news` / `News`; an existing category is never renamed).

Why the posts were uncategorised (real export, counts): of 4,343 published posts, 1,392 fell to the fallback. All 1,392 have no WordPress category, no tags and no usable Yoast primary category (310 name a primary category id that is not in the export). They are concentrated in 2012-2017 (about 250), 2020-2022 (about 400) and 2023-2024 (about 680). Tags are essentially unused (1 post).

What predicts the existing categories: **time, not topic**. Up to 2017 the posts that have a category are almost all "missions"; 2018-2022 mostly "interviews"; from 2024 mostly "news". Topical keywords (health, education, business, gospel and so on) predicted the existing categories at 10-25% precision and are not used. The classifier therefore adds up two kinds of evidence per category (all in `src/import/categoryRules.ts`, defaults in `categoryRulesDefault.ts`): explicit cue phrases (title x3, excerpt x2, body x0.5, at most twice), and neighbour evidence, the share of already categorised posts published within a window of months (widened by doubling for sparse periods). A winner needs `minScore` and a `minMargin` over the runner-up; otherwise the post goes to the fallback category and into the review file. Deterministic, offline, no model.

Provenance: every created article writes a `category` line to the rollback manifest (legacy id, step, category slug, and in rules mode the winning rule id, score, runner-up and its score). Rollback ignores these lines. The review CSV (`legacy_id,suggested_category,score,runner_up,runner_up_score`) lists posts left in the fallback with a suggestion; it holds no titles or text.

Measure before trusting: `npm run import:categorise-eval -- --file <export.xml> [--rules <file>] [--detail-file <csv>]` classifies the already categorised posts with their own category hidden (validation) and then the unplaced ones (counts only). On the real export: validation 2,951 posts, 2,425 confident, precision 68%. Of the 1,392 unplaced posts 672 get a confident category (interviews 542, missions 90, publishers-note 29, news 10, opinion 1) and 720 stay in the fallback. Precision is about two thirds, so treat the result as a first pass for editors, not as truth; the review file and manifest make it auditable.

Dry run versus apply: the dry run used to report 76 categories created where apply creates 15, because a skipped post cleared the dry run's "already counted" cache and every category was counted again. The dry run now remembers what it would create (`dryCreated`), and a test compares it with apply. On the real export the dry run now reports 15.

## Legacy media map export (A12)

The public host serves old `/wp-content/uploads/...` addresses from an exact map that the owner exports from the CMS and provisions privately. The
host never scans media and never holds a staff credential. Format and rules: `docs/api-contracts.md`, "Go-live A12: legacy media map". Note that
the format differs from the proposal in PR #58, which must be updated.

Run it from `apps/cms` against the database that holds the imported media, with every output OUTSIDE the repository:

```
# Dry run (default): counts and digests only, nothing written
npm run export:media-map --
# Write the map plus <out>.sha256. Optional: recorded thumbnail aliases and an itemised detail file
npm run export:media-map -- --out D:\private\media-map.json --detail-file D:\private\media-map-details.txt --aliases D:\private\aliases.json
```

Only media that anonymous readers can read are exported (published article images, approved live photos, delivered ad creatives). The CLI prints
`excluded` counts (`notAnonymous` is normal: every private or withdrawn upload; it is never written into the file). Read the detail file: it lists paths
claimed by more than one media (those are dropped) and rejected aliases. The export refuses more than 50,000 entries (aliases included) or 8 MiB.

**Provisioning check.** The digest that matters is the sha256 of the exact bytes of the file. Copy `media-map.json` and `media-map.json.sha256` to the
public host's provisioning path over a private channel and run `sha256sum -c media-map.json.sha256` there before the host swaps it in atomically. The
`content-sha256` printed and stored inside the file is only a stable content id (same content, same id). Never commit either file: they list every
public legacy path. `0600` has no effect on Windows; protect the folder with its permissions instead.

- **Rotation.** Export again whenever imports finish or on a schedule, then replace the map and its `.sha256` together; the old map keeps working until swapped.
- **Withdrawal.** With the #58 design (no-store, anonymous CMS check on every request) withdrawal is immediate: when an article is unpublished or
  archived its media stops being anonymously readable and the old address answers 404 straight away. The next export then drops the entry; re-export
  and rotate promptly so the map does not keep stale paths. Exceptions: media used by another published article stays public, and an ad creative
  stops being public when its campaign ends. If a bounded cache is ever added, the window is export time + host reload + cache lifetime. Images already
  downloaded cannot be recalled.
- **Aliases.** Thumbnail addresses (`photo-300x200.jpg`) are served only when recorded in the `--aliases` JSON as
  `[{"alias":"2023/10/photo-300x200.jpg","path":"2023/10/photo.jpg"}]`; they are never guessed, and an alias never overrides a real file with that name.

## Checking the uploads folder

The uploads folder comes from a server that was compromised, so every file in it is untrusted. How to get it off the old server safely is in `docs/uploads-download.md`. Before the first import run the read-only check on the copy:

```
cd apps/cms
npm run import:uploads-check -- --uploads D:\churchtimes-private\uploads-raw --wxr D:\churchtimes-private\export.xml --out D:\churchtimes-private\reports\uploads-detail.jsonl
```

`--uploads` and `--wxr` are required; `--out` is optional (a NEW file: the command refuses an existing file, the export itself and a place inside the uploads folder, judged by real paths; it never overwrites) and receives one JSON line per file and per reference (real file names: private, owner-only permissions on Linux and macOS). Both
folders and `--out` must be outside every git work tree (the command refuses otherwise) and `--out` must not be inside the uploads folder. The same exclusive-create rule applies to `--detail-file` of `import:convert-wxr`, `import:convert` and `import:rehearse`, and to `--uploads-detail-file` (one shared helper, `privateOut.ts`). Nothing is written except `--out`; nothing is executed, no database, no network.
Only counts are printed. Exit code: 0 done, 1 failed, 2 bad usage or location, 3 done but unsafe files were found (the loader still refuses them, so that is a finding, not a blocker).

- **Importable** means a `.jpg`, `.jpeg`, `.png` or `.webp` picture, or an audio/video file of the `audioVideo` block (`.mp4`, `.m4v`, `.webm`, `.mp3`, `.m4a`, `.ogg`, `.oga`) (allow-list, after lower-casing and stripping trailing dots and spaces) whose first bytes are that image type, not empty and at most 10 MB (`MAX_IMAGE_BYTES` in `src/lib/mediaLimits.ts`, shared by the uploads check, the loader and the Media collection; audio/video use the `MEDIA_AV_MAX_MB` cap). Reasons below are rejections. The real protection is the Media collection: it takes JPEG/PNG/WebP by magic bytes, refuses more than 40 megapixels and re-saves every picture with sharp, so a script hidden after the image data is not stored.
- **Rejected, by reason**: `dangerous-extension` (php, phtml, phar, sh, exe, js, html, svg, zip and other archives, a dangerous extension inside a name such as `x.php.jpg`, `x.html.jpg`, `x.svg.png`), `hidden-file` (a name that starts with a dot, such as `.htaccess`),
  `bad-name` (control characters, backslash, colon, a Windows device name such as `con.png`, a trailing dot or space), `symlink` (a link or junction; never followed), `hard-link` (a file with more than one name), `zero-byte`, `magic-mismatch` (an image extension whose first bytes are not that image type), `not-media` (any other extension or none), `unsupported-type` (gif, bmp, ico, avif, pdf: real files that the CMS does not take; counted apart as `not importable`, never as safe or present), `too-large` (over the cap of its type; never read), `not-a-file`, `unreadable`.
  A script marker (`<?php` or `<script`) inside an otherwise valid JPEG/PNG/WebP is NOT a rejection: it is counted as an advisory `warning` among the safe files (random image data contains such bytes by chance, and the re-save removes any payload). `<?=` is no longer searched for. Audio and video are stored as uploaded (no re-save), so a script marker inside one stays a rejection (`polyglot`).
  WordPress itself leaves an `index.php` ("silence is golden") in some upload folders: it is rejected like any other script and does no harm.
- **Attachments in the export**: distinct paths, `present`, `missing`, `only size variants on disk` (the original is gone but `name-300x200.jpg` files exist; the loader cannot use them), name differs by Unicode form (NFC against NFD)
  or by letter case (the loader looks files up exactly, so these need a rename on a case-sensitive file system), and rejected as unsafe.
- **Images in published article bodies**: the same, plus `present as the original of a size variant` (the body points at `name-300x200.jpg`, the loader finds `name.jpg`).
- **Featured images of published posts**: present, missing, attachment not in the export, rejected.
- **Rest of the folder**: size variants of listed images, unreferenced files, and duplicate content (same SHA-256) as groups and extra copies.

The loader repeats the safety checks itself (`media.ts`, via `uploadSafety.ts`): a file that fails any of them is never ingested (the file is read once, up to the cap, checked from that buffer, and the buffer is what is uploaded; a refused file counts as `rejected-unsafe`, `too-large` or `unsupported-type`), even when `--uploads` is used without the check; it is counted under
`media.unresolved`. The import report also prints `featured images resolved` and `featured images rejected`. `import:rehearse` with `--file` and `--uploads` prints the same counts first, so one command reads the whole picture
(add `--uploads-detail-file <path>` for the per-file detail).

## Running the rehearsal on a clean CI runner

`.github/workflows/import-rehearsal.yml` (manual: Actions, "Import rehearsal", Run workflow) runs `npm run import:rehearse` on a GitHub runner with a throwaway embedded PostgreSQL and a large synthetic export. Defaults are the real archive size (4,346 posts, 200 images). The counts-only result, timings and PASS/FAIL checks appear in the job summary. It uses no repository secrets and reads no real data.
