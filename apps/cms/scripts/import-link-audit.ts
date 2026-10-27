/**
 * `npm run import:link-audit -- --file <export.xml> [--out <rows.jsonl>] [--redirects-out <rules.csv>] [--article-path '/{slug}/']
 *  [--category-path '/category/{slug}/'] [--tag-path '/tag/{slug}/'] [--old-host a.test,b.test]
 *  [--review-out <review.csv>] [--suggested-fixes-out <suggested.csv>] [--link-fixes <link-fixes.csv or .json>]`
 * Read-only: classifies every link in published post bodies and prints COUNTS ONLY. `--out` (per-link rows, addresses
 * included), `--redirects-out` (exact-match 301 rules in the `import:redirects` CSV format), `--review-out` (one row per
 * problem link with its likely cause; addresses included), `--suggested-fixes-out` (high-confidence matches only, never applied
 * automatically) and `--link-fixes` (the owner's decisions) must be outside every git work tree. Nothing is written to a database.
 */
import fs from 'node:fs'
import path from 'node:path'

import { resolveArticlePathTemplate } from '../src/lib/redirectPaths'
import { auditLinks, formatLinkAudit, redirectsCsv, type AuditRow } from '../src/import/linkAudit'
import { countByCause, reviewCsv, suggestedFixesCsv } from '../src/import/linkDiagnose'
import { formatLinkFixes, LinkFixesError, readLinkFixesFile } from '../src/import/linkFixes'
import { resolveSiteHosts } from '../src/import/linkSiteHosts'
import { isInsideRepo } from '../src/import/safePaths'
import { readWxrFile } from '../src/import/wxr'

const template = (t: string) => (slug: string) => t.replace('{slug}', slug)

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const val = (n: string) => {
    const i = argv.indexOf(n)
    const v = i >= 0 ? argv[i + 1] : undefined
    return v && !v.startsWith('--') ? v : undefined
  }
  const file = val('--file')
  const out = val('--out')
  const rulesOut = val('--redirects-out')
  if (!file) {
    console.error('LINK_AUDIT_USAGE')
    return 2
  }
  const reviewOut = val('--review-out')
  const suggestedOut = val('--suggested-fixes-out')
  const fixesFile = val('--link-fixes')
  for (const p of [file, out, rulesOut, reviewOut, suggestedOut, fixesFile]) {
    if (p && isInsideRepo(p)) {
      console.error('LINK_AUDIT_PATH_INSIDE_REPO')
      return 2
    }
  }
  const articleT = val('--article-path') ?? resolveArticlePathTemplate(process.env)
  const categoryT = val('--category-path') ?? '/category/{slug}/'
  const tagT = val('--tag-path')
  for (const t of [articleT, categoryT, tagT]) {
    if (t && (!t.startsWith('/') || t.startsWith('//') || !t.includes('{slug}'))) {
      console.error('LINK_AUDIT_BAD_TEMPLATE')
      return 2
    }
  }
  const rows: AuditRow[] = []
  const hosts = resolveSiteHosts(process.env)
  let linkFixes
  if (fixesFile) {
    try {
      linkFixes = readLinkFixesFile(path.resolve(fixesFile), { articleTemplate: articleT, siteHosts: new Set([hosts.primary, ...hosts.legacy]) })
    } catch (e) {
      console.error(e instanceof LinkFixesError ? e.code : 'LINK_FIXES_UNREADABLE')
      return 2
    }
  }
  const { audit, rules, problems, fixes } = await auditLinks(() => readWxrFile(path.resolve(file)), {
    primaryHost: hosts.primary,
    legacyHosts: hosts.legacy,
    linkFixes,
    articlePath: template(articleT),
    categoryPath: template(categoryT),
    tagPath: tagT ? template(tagT) : null,
    extraHosts: (val('--old-host') ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    onRow: out ? (r) => rows.push(r) : undefined,
  })
  console.log(formatLinkAudit(audit))
  console.log(`site hosts: primary ${hosts.primary}; ${hosts.legacy.length} old host name(s) (and www. variants) mean the same site and are rewritten to the same path`)
  if (fixes) console.log(formatLinkFixes(fixes))
  const causes = Object.entries(countByCause(problems)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  console.log(`problem links still unresolved: ${problems.length}`)
  for (const [k, v] of causes) console.log(`  ${k}: ${v}`)
  const write = (p: string, text: string) => {
    fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true })
    fs.writeFileSync(p, text, { mode: 0o600 })
  }
  if (out) {
    write(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
    console.log(`Per-link rows written to the private file (${rows.length}).`)
  }
  if (reviewOut) {
    write(reviewOut, reviewCsv(problems))
    console.log(`Review file written to the private path (${problems.length} rows): decide per row (new path | remove-link | keep-text), save as link-fixes.csv, rerun with --link-fixes.`)
  }
  if (suggestedOut) {
    const s = suggestedFixesCsv(problems)
    write(suggestedOut, s.csv)
    console.log(`Suggested fixes written to the private path (${s.count} high-confidence matches; NOT applied until the owner approves them).`)
  }
  if (rulesOut) {
    write(rulesOut, redirectsCsv(rules))
    console.log(`Redirect rules written to the private file (${rules.length}); review, then npm run import:redirects -- --file <it> (dry run first).`)
    console.log(`Host-level default (a request on ${hosts.legacy.join(', ')} goes to the same path on ${hosts.primary}) is the public host's job, see docs/legacy-hosts.md; it is not a path rule.`)
  }
  return 0
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(`LINK_AUDIT_FAILED ${e instanceof Error ? e.name : 'Error'}`)
    process.exit(1)
  },
)
