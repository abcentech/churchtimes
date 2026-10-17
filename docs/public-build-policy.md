# Public source checks and dedicated Pages rebuilds

Feature PRs into `feat/newsroom-mvp` commit source, tests and docs. They do not
commit generated `site/**`, root `newsletter/**` route pages, root
`index.html`, or `.nojekyll`. Edit the actual
HTML source at `src/index.template.html`; Vite already reads that template.
This prevents one feature's compiled bundle from replacing another's bundle.

Website CI checks the exact event base/head commit SHAs with full Git history.
PR comparisons use those SHAs with Git’s standard three-dot diff, so unrelated
new integration commits are not attributed to the feature; pushes compare the
exact before/after commits. It rejects generated-file changes in feature PRs, builds the actual frontend,
and validates that compiled JS/CSS entries and stylesheet assets exist as
nonempty local files inside `dist`. Missing files, source entry points, external
assets and symlinks escaping the build fail this check. Generated newsletter
confirmation/unsubscribe pages are checked when present, including configured
root or mounted asset bases. This is real build
validation, not browser/CMS evidence and not proof that the committed Pages
export is fresh. Integration source pushes use the same explicit mode. The job
summary states that the committed export is pending a dedicated rebuild.

After the approved source PRs have merged, open one dedicated branch named
`agent/rebuild-site-<purpose>` (or `agent/rebuild-site/<purpose>`), run
`npm run export:pages`, and commit only generated exports and optional docs.
The branch is a validation convention, not merge or deployment authorization.
CI rejects source/workflow changes mixed into this dedicated rebuild and runs
the existing strict `npm run check:pages`. The resulting integration push also
runs that strict comparison. Main/release checks retain strict committed-export
validation. The existing strict command is unchanged and remains available
locally; no stale-export failure is silently ignored or reported as matching.

Feature PRs using this policy depend on the policy PR until it merges. Once
approved, the final rebuild is a separate reviewable PR; nothing is deployed by
this change. Production quality still builds from source and enforces the same
performance/accessibility budgets.

Unit checks use explicitly synthetic local build files and a temporary real
Git repository; they do not claim CMS or browser integration. CI's source check
uses the actual Vite build output.
