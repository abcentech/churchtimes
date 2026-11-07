# `archive-candidate/1`: recovered archive pages for the CMS importer

Status: version 1, read by `npm run import:archive-candidates` (see `docs/import.md`, "Archive candidates"). Producer: the
archive recovery tooling (Codex lane, `tools/`). Consumer: this CMS. The executable form of this document is
`src/lib/archiveCandidate.ts` (`validateCandidate`); if they disagree the code wins and this file is a bug.

## What a file is

- A UTF-8 text file in **JSON Lines** format: one JSON object per line, `\n` or `\r\n` line ends, an optional byte order mark on
  the first line, blank lines ignored. One line is one recovered page.
- It lives **outside every Git checkout** (the importer refuses a file inside a work tree). Real captures are never committed;
  fixtures are synthetic.
- Every line carries `"schema": "archive-candidate/1"`. Another value rejects that line (`schema-version`). A breaking change
  becomes `archive-candidate/2` and needs a new importer release.
- The importer is **strict**: an unknown key, a wrong type, an over-long value, an address that is not http or https, or any script
  content rejects the line. Rejected lines are counted by a fixed reason code and never echoed.

## Fields

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `schema` | string | yes | exactly `archive-candidate/1` |
| `title` | string | yes | 1 to 240 characters after trimming, plain text: no `<` or `>`, no control characters |
| `byline` | string or null | no | up to 200 characters, plain text; `null` or absent when unknown. Stored as `bylineName`. |
| `date` | string or null | no | the publication date the page claims: `YYYY-MM-DD` or a full ISO 8601 date-time **with** a zone (`Z` or `+01:00`); a real calendar day; `null` or absent when unknown. Stored as `provenance.originalDate`. Never becomes `publishedAt`. |
| `bodyHtml` | string | yes | the article body as HTML, non-empty, up to 1,000,000 characters. No `<script>` (any spelling), no `javascript:`, `vbscript:` or `data:text/html`. Converted by the same sanitising HTML-to-Lexical converter as the WordPress import (unknown tags and every unrecognised attribute are dropped; images are not imported by this command). |
| `originalUrl` | string | yes | the address the page was captured from: `http` or `https` only, up to 2,000 characters, no spaces or control characters, no `user:password@`. Stored as `provenance.sourceUrl` and used for duplicate detection. |
| `canonicalUrl` | string or null | no | the page's own declared canonical address, same address rules; `null` or absent when none. Informational (not stored in version 1). |
| `host` | string | yes | `originalUrl`'s host name, lower case (`old-site.test`), up to 253 characters. Must equal it exactly (`host-mismatch` otherwise). Stored as `provenance.sourceHost`. |
| `captureTimestamp` | string | yes | when the capture was taken: full ISO 8601 date-time **with** a zone; not more than 24 hours in the future. Normalised to UTC. |
| `rawSha256` | string | yes | 64 lower-case hex characters: SHA-256 of the **raw captured bytes** the page was extracted from (the provenance hash). Two lines with the same value are the same capture. |
| `media` | array | yes | media references found in the page, at most 200 (may be empty). Validated and counted; **not imported** in version 1. Items below. |
| `confidence` | string | yes | `partial`, `citation-only` or `missing`. **`verified-full` does not exist and is rejected** (`confidence-verified-full`): only an editor can establish that a recovery is complete. |
| `reviewer` | object or null | no | placeholders for the editorial desk: `{ "assignee": string or null, "notes": string or null }`, up to 120 and 1,000 characters, plain text. Informational (not stored in version 1); the review itself happens in the CMS. |

`confidence` meaning: `partial` is a page whose body was recovered but may be truncated or missing parts; `citation-only` is a page
where only a fragment (headline, a few lines) survived; `missing` is a record where the body could not be recovered and `bodyHtml`
holds only what is known (a note is fine, but it must not be empty).

### `media[]` items

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `url` | string | yes | the media address as referenced by the page; http or https only, up to 2,000 characters |
| `localSha256` | string or null | no | 64 lower-case hex characters when the file was recovered into the producer's private store; `null` when not recovered |
| `mime` | string or null | no | a media type such as `image/jpeg` (sniffed from the bytes, not the extension) |
| `alt` | string or null | no | up to 300 characters, plain text |

Unknown keys inside a media item reject the line.

## Size limits

| Limit | Value |
| --- | --- |
| One line | 3,000,000 bytes |
| `title` | 240 characters |
| `byline` | 200 characters |
| `bodyHtml` | 1,000,000 characters |
| URLs | 2,000 characters |
| `host` | 253 characters |
| `media` items | 200 per line |
| `reviewer.assignee` / `reviewer.notes` | 120 / 1,000 characters |

## What the importer does with a valid line

- Creates one **draft** article (`status: draft`), never published, never scheduled, with `provenance.reviewStatus: pending`.
  The slug comes from the title. A slug owned by a different article, or a reserved route name, becomes `...-archive` (then
  `-archive-2` and so on); the same slug and the same normalised title means the article is already on the site and is skipped.
- Skips a line already in the CMS: same `originalUrl` (also with or without `www.`, `http` or `https`, a trailing slash),
  same `rawSha256`, or an article whose WordPress `legacyUrl` is that address.
- Skips a second line in the same file with the same address or the same `rawSha256` (the first wins).
- Prints counts only. Per-row outcome codes (row number and a fixed code, never text) go to a private file outside every checkout.

## JSON Schema (draft 2020-12)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "archive-candidate/1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema", "title", "bodyHtml", "originalUrl", "host", "captureTimestamp", "rawSha256", "media", "confidence"],
  "properties": {
    "schema": { "const": "archive-candidate/1" },
    "title": { "type": "string", "minLength": 1, "maxLength": 240, "pattern": "^[^<>]*$" },
    "byline": { "type": ["string", "null"], "maxLength": 200, "pattern": "^[^<>]*$" },
    "date": { "type": ["string", "null"], "pattern": "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+-]\\d{2}:\\d{2}))?$" },
    "bodyHtml": { "type": "string", "minLength": 1, "maxLength": 1000000 },
    "originalUrl": { "type": "string", "maxLength": 2000, "pattern": "^https?://[^\\s@/]+(/\\S*)?$" },
    "canonicalUrl": { "type": ["string", "null"], "maxLength": 2000, "pattern": "^https?://[^\\s@/]+(/\\S*)?$" },
    "host": { "type": "string", "maxLength": 253, "pattern": "^[a-z0-9.-]+(:\\d+)?$" },
    "captureTimestamp": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+-]\\d{2}:\\d{2})$" },
    "rawSha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "media": {
      "type": "array",
      "maxItems": 200,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["url"],
        "properties": {
          "url": { "type": "string", "maxLength": 2000, "pattern": "^https?://[^\\s@/]+(/\\S*)?$" },
          "localSha256": { "type": ["string", "null"], "pattern": "^[0-9a-f]{64}$" },
          "mime": { "type": ["string", "null"], "pattern": "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,60}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,60}$" },
          "alt": { "type": ["string", "null"], "maxLength": 300, "pattern": "^[^<>]*$" }
        }
      }
    },
    "confidence": { "enum": ["partial", "citation-only", "missing"] },
    "reviewer": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "properties": {
        "assignee": { "type": ["string", "null"], "maxLength": 120 },
        "notes": { "type": ["string", "null"], "maxLength": 1000 }
      }
    }
  }
}
```

The JSON Schema is a convenience for producers. It cannot express the cross-field and semantic rules, which the importer
enforces: `host` equals the host of `originalUrl`, dates exist on the calendar, `captureTimestamp` is not in the future,
the body contains no script content, and no control characters appear in plain-text fields.

## Example (synthetic; invented content, reserved `.test` host)

One line of a file (shown wrapped here; in the file it is a single line):

```json
{"schema":"archive-candidate/1","title":"Synthetic diocese announces a harvest festival","byline":"Staff Reporter","date":"2014-03-09","bodyHtml":"<p>A synthetic paragraph about an invented festival.</p><p>A second paragraph with a <a href=\"https://example.test/ref\">reference</a>.</p>","originalUrl":"https://old-site.test/2014/03/synthetic-harvest-festival/","canonicalUrl":null,"host":"old-site.test","captureTimestamp":"2020-01-15T10:20:30Z","rawSha256":"0000000000000000000000000000000000000000000000000000000000000000","media":[{"url":"https://old-site.test/files/synthetic.jpg","localSha256":null,"mime":"image/jpeg","alt":null}],"confidence":"partial","reviewer":{"assignee":null,"notes":null}}
```

(The all-zero hash is a placeholder that satisfies the format; real files carry the SHA-256 of the captured bytes.)

## Fields stored on the article (`provenance` group, staff-only)

| Article field | From |
| --- | --- |
| `provenance.sourceUrl` | `originalUrl` |
| `provenance.sourceHost` | `host` |
| `provenance.captureTimestamp` | `captureTimestamp` |
| `provenance.originalDate` | `date` (when present) |
| `provenance.sourceSha256` | `rawSha256` |
| `provenance.confidence` | `confidence` |
| `provenance.importBatch` | the run's batch label (`arc-` plus 12 hex characters of the file hash, or `--batch`) |
| `provenance.reviewStatus` | `pending` on import; an editor sets `reviewed` or `rejected` in the admin |
| `provenance.reviewedBy`, `reviewedByName`, `reviewedAt` | server-set when `reviewStatus` becomes `reviewed` (cleared otherwise); editor roles read them, nobody writes them. The approver cannot publish or schedule the article (admins exempt) |

The group is never part of any public response. An article with an `importBatch` cannot be set to `published` or `scheduled`
until `provenance.reviewStatus` is `reviewed` (HTTP 409 otherwise, for every caller).
