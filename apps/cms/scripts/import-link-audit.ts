/**
 * `npm run import:link-audit -- --file <export.xml> [--out <rows.jsonl>] [--redirects-out <rules.csv>] [--article-path '/{slug}/']
 *  [--category-path '/category/{slug}/'] [--tag-path '/tag/{slug}/'] [--old-host a.test,b.test]`
 * Read-only: classifies every link in published post bodies and prints COUNTS ONLY. `--out` (per-link rows, addresses
 * included) and `--redirects-out` (exact-match 301 rules in the `import:redirects` CSV format) must be outside every
 * git work tree. Nothing is written to a database.
 */
import fs from 'node:fs'
import path from 'node:path'

import { resolveArticlePathTemplate } from '../src/lib/redirectPaths'
import { auditLinks, formatLinkAudit, redirectsCsv, type AuditRow } from '../src/import/linkAudit'
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
  for (const p of [file, out, rulesOut]) {
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
  const { audit, rules } = await auditLinks(() => readWxrFile(path.resolve(file)), {
    articlePath: template(articleT),
    categoryPath: template(categoryT),
    tagPath: tagT ? template(tagT) : null,
    extraHosts: (val('--old-host') ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    onRow: out ? (r) => rows.push(r) : undefined,
  })
  console.log(formatLinkAudit(audit))
  const write = (p: string, text: string) => {
    fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true })
    fs.writeFileSync(p, text, { mode: 0o600 })
  }
  if (out) {
    write(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
    console.log(`Per-link rows written to the private file (${rows.length}).`)
  }
  if (rulesOut) {
    write(rulesOut, redirectsCsv(rules))
    console.log(`Redirect rules written to the private file (${rules.length}); review, then npm run import:redirects -- --file <it> (dry run first).`)
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
