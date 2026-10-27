# Uploads verification pack: uploads-pack/1

This is the E1 contract proposal for CMS-lane review, before implementation.
The verifier and its CLI do not exist yet. No uploads were scanned, copied,
transferred or imported for this documentation PR. The existing CMS
`import:uploads-check` reads a directory, not this manifest; consuming the
manifest requires a separate CMS-lane decision. This format is separate from
`media-map/1`, which serves already approved CMS media.

## Inputs, storage and handling

Work offline on an owner-supplied copy of `wp-content/uploads` and the existing
WXR-parser attachment inventory. Both inputs, all outputs and any accepted-file
pack must be outside every Git checkout. Resolve existing ancestors and reject
repository paths, including Git worktrees, symlink aliases and nested repos.
Never connect to the old or production server. Open input files read-only; do
not rename, delete, rewrite or move them. The owner/operator supplies the copy.

Create new private output directories with mode 0700 and files with mode 0600
(or equivalent restrictive permissions). Refuse existing outputs. A temporary
output is published atomically only after a successful scan. Interrupted scans
must not leave a manifest marked complete. Never log private paths, names,
attachment URLs, file hashes or file contents to GitHub or public reports.

Walk with lstat and do not follow symlinks, including directory symlinks. Reject
hard-linked files. Check the opened file descriptor and its identity/size again
after reading; reject changed or unreadable files rather than verifying one
file and copying another. Stream hashing/copying with per-file caps. Copy only
accepted bytes into a new pack, preserving their canonical relative paths.
Quarantine is a **logical refusal** recorded privately, not moving unsafe files
or copying them into the pack. CMS validation and image re-saving remain
required after transfer; a pack is not publication approval or a malware-free
guarantee.

## Private manifest contract

One UTF-8 JSON document, with exactly these top-level fields. Incompatible field
changes require a new schema version; do not rename published v1 fields.

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | string | Exactly `uploads-pack/1`. |
| `createdAt` | string | UTC ISO 8601 completion timestamp. |
| `complete` | boolean | Exactly true in a published manifest. |
| `limits` | object | `imageMaxBytes`, `avMaxBytes`: positive integer effective caps. |
| `scanner` | object | `name`, `version`: verifier identifier and version strings. |
| `antivirus` | object | `engine`: string or null; `status`: `not-run`, `passed`, `failed` or `error`. Optional ClamAV outcome; `not-run` is not a clean scan. |
| `entries` | array | One entry per encountered file or refused link, ordered by canonical path and private detail id. |
| `reconciliation` | object | Aggregate integer fields defined below. |

Each entry has exactly these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `detailId` | string | Unique opaque id joining a separate private detail JSONL record. Never an instruction to open a path. |
| `path` | string or null | NFC relative path under the uploads root; null when a safe unique canonical path cannot be assigned. |
| `size` | integer or null | Nonnegative observed byte count; null if unavailable. |
| `sha256` | string or null | Lowercase 64-hex SHA-256 over accepted original bytes; null if refused before a complete bounded read. |
| `mime` | string or null | Type established from magic bytes, never the filename alone. |
| `width`, `height` | integer or null | Positive parsed image dimensions; null for audio/video or unavailable dimensions. |
| `status` | string | `accepted` or `quarantined`. |
| `reason` | string or null | Null for accepted entries; one refusal code for quarantined entries. |
| `warnings` | array of strings | Advisory codes, initially `script-marker`. Empty when absent. |

Accepted entries require a non-null safe path, size, hash and allowed MIME.
Images also require dimensions. Private detail JSONL records contain
`detailId` and `sourcePath` (the original relative filesystem spelling, JSON
escaped); they never supply paths for automatic import. This preserves evidence
of malformed names and NFC collisions without making them usable pack paths.

For example, this **synthetic entry shape** is illustrative, not a scan result:

```json
{
  "detailId": "synthetic-1",
  "path": "2026/01/synthetic.png",
  "size": 100,
  "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "mime": "image/png",
  "width": 1,
  "height": 1,
  "status": "accepted",
  "reason": null,
  "warnings": []
}
```

## Paths and CMS acceptance parity

Use `/` separators relative to the supplied uploads root, without the
`wp-content/uploads/` prefix. NFC-normalise each filesystem segment; do not
URL-decode filesystem names or case-fold the canonical key. Refuse absolute,
UNC/device, drive, traversal, empty-segment, control-character, backslash,
alternate-stream and platform-reserved names. Follow the merged CMS
`unsafeNameReason` policy for hidden names, extensions and trailing dots/spaces.
NFC/NFD pairs or other canonical-path collisions quarantine **all** colliding
entries; never silently overwrite or pick one. Case/URL-encoding similarities
are reconciliation candidates only, never automatic file substitutions.

Acceptance follows the merged CMS implementation in
`apps/cms/src/import/uploadSafety.ts`, `apps/cms/src/lib/mediaLimits.ts` and
`apps/cms/src/lib/avMedia.ts`:

- Images: jpg/jpeg, png and webp; cap 10,485,760 bytes. No image cap increase is
  assumed. Magic bytes must match; an invalid/unreadable dimension is refused.
- Audio/video: mp4, m4v, webm, mp3, m4a, ogg and oga, with extension-compatible
  MIME determined from bytes. Effective cap follows `MEDIA_AV_MAX_MB`: default
  100 MiB, integer range 1–500 MiB, recorded in `limits.avMaxBytes`.
- Scripts, markup, executables, configuration files, archives and SVG are
  refused, including dangerous inner extensions such as `shell.php.jpg`.
  GIF, BMP, ICO, AVIF, PDF, TIFF and HEIC/HEIF remain unsupported.
- A script marker inside an otherwise valid JPEG/PNG/WebP is an advisory warning,
  matching the refreshed relay and CMS re-save policy. The same marker in
  audio/video is a `polyglot` refusal. A PHP file merely named jpg fails magic
  validation. Marker scanning alone is not a full parser or malware detector.

Use the CMS refusal codes where applicable: `dangerous-extension`, `hidden-file`,
`bad-name`, `symlink`, `hard-link`, `zero-byte`, `too-large`, `not-a-file`,
`not-media`, `unsupported-type`, `magic-mismatch`, `polyglot`, `unreadable`.
Pack-specific codes are `path-collision`, `changed-during-read`,
`invalid-dimensions` and `antivirus-failed`. Scanner errors block successful
completion; malware detections quarantine the affected entries. Runtime checks
must match the effective caps instead of trusting extension or manifest claims.

## Reconciliation and public report

`reconciliation` contains these nonnegative integer fields:
`attachmentsTotal`, `attachmentsVerified`, `attachmentsMissing`,
`attachmentsRefused`, `filesUnreferenced`, `variantsWithOriginal`,
`variantsWithoutOriginal`, `duplicateHashGroups`, `duplicateExtraFiles`,
`caseOnlyCandidates`, `encodingOnlyCandidates`.

Classify each attachment as verified, missing or refused; their counts sum to
`attachmentsTotal`. Count repeated attachment records as records, not files.
Variants are filename suffix candidates such as `-300x200`, not proof that an
original exists. Exact paths win; ambiguous case/encoding candidates require
review. Hash equality identifies duplicate bytes, not permission to delete a
file. Attachment inventories come from the existing WXR parser/report output;
do not introduce another XML parser.

The shareable report contains aggregate counts only: totals, acceptance/refusal
counts by reason, warning counts, reconciliation counts, effective limits and
antivirus status. Private manifests/details retain per-file paths and hashes.
No real filenames, URLs, hashes, source directory names or attachment ids enter
GitHub. Synthetic fixtures may contain reserved-domain names and fake hashes.

## Owner/operator runbook and implementation acceptance

The operator obtains a read-only copy through a separately approved process;
this tool never fetches it. Record the source-copy transfer digest privately,
verify the copy, run the offline verifier into a new private output, review
refusals, then transfer only accepted bytes plus the private manifest through an
approved channel. Recompute hashes at the receiving end and stop on any
mismatch before giving the pack root to `import:uploads-check` and the CMS
importer. Existing CMS validation still runs. No production transfer, CMS write,
mail, DNS or nameserver action is authorised by this document.

Implementation acceptance remains **unexecuted**: synthetic PHP-as-jpg,
symlink/hard-link, traversal, changed-file, marker, MIME/extension mismatch and
NFC/NFD collision cases; manifest/permission/atomic-output checks; reconciliation
fixtures; a synthetic 5,000-file counts-only report; and read-only-input proof.
Publish the implementation and real test results in a separate PR after this
field contract is reviewed. No stub test is represented as a completed scan.
