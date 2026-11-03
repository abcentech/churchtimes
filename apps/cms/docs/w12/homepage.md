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
