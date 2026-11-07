# W12 public homepage and section feeds

The public homepage selects its lead, headline rail and latest cards from the
anonymous published-articles API, ordered by publication date. The next page is
loaded only when requested. A category filter resolves the CMS category IDs;
combined editorial sections match both primary and additional categories.
An article appears only once on a homepage, even when pages or sections overlap.
Sponsored and opinion stories retain their editorial labels.

When the CMS is unconfigured or unavailable, the public site falls back to the
bundled edition. A healthy but empty CMS shows an honest empty state. If a later
page fails, already-loaded CMS stories remain visible with a retry control.
Filtering and route changes discard stale responses; no staff credentials or
unpublished articles are requested. CMS data, HTML attributes and links are
validated and escaped using the existing public projection and media helpers.

The initial homepage controller is a lazy chunk so it does not consume the
initial reader budget. The public host uses the site icon for the CMS homepage's
social image, avoiding a stale bundled-story preview. No advertising, analytics
or third-party service is enabled by this change. Existing public origin and CMS
CORS settings still apply; no new environment variable or schema is needed.

CMS articles can be saved locally in the same reading list as bundled briefings.
Only article slugs are stored after a reader chooses Save; saved details are
retrieved again from the public, published-only API. Related stories use the
article's primary category, excluding the article itself and duplicates. If the
CMS is unavailable, readers can still remove saved entries; recommendations
simply collapse. The original-publication briefing callout remains exclusive
to the bundled edition.

The production quality audit prefers Playwright's installed Chromium and falls
back to available system browsers. An explicit `CHROMIUM_PATH` remains
authoritative. If no browser starts, the audit closes its local host and fails
promptly rather than leaving the CI job running until its timeout. The quality
runner also requires a completed passing report, even if a child process exits
without an error status.
