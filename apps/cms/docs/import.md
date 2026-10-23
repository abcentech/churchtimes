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
$env:IMPORT_MANIFEST_PATH = 'D:\churchtimes-private\manifests\run-1.jsonl'
npm run import:wxr -- --file D:\churchtimes-private\export.xml --uploads D:\churchtimes-private\uploads --apply
```

Flags: `--file` (required), `--uploads <folder>` (the copied `wp-content/uploads`), `--manifest <path>` or
`IMPORT_MANIFEST_PATH`, `--apply` (write), `--update` (rewrite already imported articles that nobody edited since), `--force-update` (also those), `--old-host a.test,b.test`
(extra old-site hosts; the hosts in the export's own header are always used), `--limit N` (first N posts, for trials).
Exit code 0 when clean, 1 when an article failed to convert or write, 2 for a usage or path error. Errors print one short
code (`IMPORT_USAGE`, `IMPORT_FILE_INSIDE_REPO`, `IMPORT_FILE_UNREADABLE`, `IMPORT_UPLOADS_INSIDE_REPO`, `IMPORT_MANIFEST_REQUIRED`,
`IMPORT_MANIFEST_INSIDE_REPO`, `IMPORT_MANIFEST_UNWRITABLE`, `IMPORT_TOO_MANY_FAILURES`, or a `WXR_*` code).

### What is imported

- Posts with status `publish` and no password. Everything else is counted, never written: password-protected posts
  (`passwordProtected`), other statuses (`status-draft`, ...), missing id, date or title.
- Article: title, slug (from `wp:post_name`; on a clash `-<wp id>`, then a number, is added; every candidate is checked, and links between articles use the FINAL slug), excerpt (plain text), body (converted),
  ONE category (see "Categories and authors" below), featured image (`_thumbnail_id`), byline text (see below), `publishedAt` (the GMT date), `legacyUrl` (the old permalink, see below), `legacyId`, Rank Math / Yoast title and description
  (dropped when they hold `%variables%` or are over the length limits, C2). Imported articles are `published`.
- Approved ordinary comments through `toLegacyCommentData`, plus a second email-shaped-text pass over names and bodies
  (an address becomes `[email removed]`, a name with an at-sign becomes `Anonymous`; a byline that is an email address is dropped). `parentLegacyId` is kept only
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
  must stay inside the real uploads folder. Files over 25 MB are refused.
- 50 consecutive failed writes, or (after 20 posts) more than half failing, stop the run (`IMPORT_TOO_MANY_FAILURES`). Report keys for post statuses come from a fixed set (anything else is `other`).

### Categories and authors

- **One category per article.** `Articles.category` is a single REQUIRED relationship and there is no second categories field, so
  only one WordPress category per post can be kept. The primary is the first listed category, except that WordPress's generic
  `uncategorised` / `uncategorized` is skipped when a real category exists; a post with none gets the `uncategorised` fallback.
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
status, published password-protected posts, categories (in the file, used by posts, posts with more than one), distinct authors
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

## Rehearsal and rollback

### `npm run import:rollback -- --manifest <path> [--apply] [--force] [--allow-incomplete]`

Undoes ONE import run from its manifest (`src/import/rollback.ts`). A DRY RUN unless `--apply`.

- Deletes only ids the manifest lists as CREATED by that run, and only when the row proves it: legacy comments (with a legacy id), articles (with a legacy id), media
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
  `--force` deletes those too; nothing else is overridden. After an `--update` run, rolling back the FIRST manifest therefore needs `--force`.
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
npm run import:rehearse -- --file D:\churchtimes-private\export.xml --uploads D:\churchtimes-private\uploads --detail-file D:\churchtimes-private\reports\rehearse-detail-2.json
# Conversion statistics alone (no database at all):
npm run import:convert-wxr -- --file D:\churchtimes-private\export.xml --detail-file D:\churchtimes-private\reports\convert-detail.json
```

Options: `--file` (required, outside every repository), `--uploads <dir>` (a copy of `wp-content/uploads`), `--dry-run-only`, `--detail-file <path>` (must not exist yet,
outside every repository, owner-only permissions) and `--keep` (keep the temp folder for debugging; it holds the throwaway database and, after an apply, copied media).
Exit code 0 only when every PASS/FAIL check passes and nothing failed to convert.

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
- **Loader dry run** (the `import:wxr` report): published posts accounted for X of Y (difference must be 0), skipped by reason, categories, authors, media (`unresolved by reason`, expected without `--uploads`),
  content counts, comments created / skipped by reason.
- **Apply, second apply, rollback** (not with `--dry-run-only`): apply must match the dry run and be verified in the database; the second apply must create nothing (`second apply changed nothing`);
  the rollback must remove every created row and its files, and its dry run must match it. Phase times, query counts and peak memory follow, then PASS/FAIL lines.

The detail file is JSON: `textShrink`, `emptyOutput`, `failed` (id and code), `inputOverCap` and `maxDepthHit`, all WordPress post ids. Open a post by id in the old WordPress admin to look at it. Do not paste the file, or what is in it, anywhere shared.

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

## Running the rehearsal on a clean CI runner

`.github/workflows/import-rehearsal.yml` (manual: Actions, "Import rehearsal", Run workflow) runs `npm run import:rehearse` on a GitHub runner with a throwaway embedded PostgreSQL and a large synthetic export. Defaults are the real archive size (4,346 posts, 200 images). The counts-only result, timings and PASS/FAIL checks appear in the job summary. It uses no repository secrets and reads no real data.
