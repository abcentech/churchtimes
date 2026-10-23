/**
 * `npm run import:categorise-eval -- --file <export.xml outside the repo> [--rules <rules.json outside the repo>] [--detail-file <csv outside the repo>]`
 *
 * Read-only measurement of the rule-based category classifier on a real WordPress export, COUNTS ONLY on screen.
 *  1. Validation: posts that already have a real category (WordPress or a resolvable Yoast primary) are classified with their
 *     own category hidden (their vote is removed from the neighbour evidence); confident answers are compared with the truth.
 *  2. Target: posts that would fall to the fallback category: how many get a confident category, the distribution by category,
 *     how many stay in the fallback.
 * `--detail-file` writes legacy id, suggested category, score, runner-up, runner-up score and confidence per target post (no
 * titles, text or addresses). It must be outside every repository and must not exist.
 */
import fs from 'node:fs'
import path from 'node:path'

import { classify, compileRules, EraIndex, parseCategoryRules, textForClassification, type Classification } from '../src/import/categoryRules'
import { DEFAULT_CATEGORY_RULES } from '../src/import/categoryRulesDefault'
import { chooseCategoryChain } from '../src/import/mapping'
import { isInsideRepo } from '../src/import/safePaths'
import { readWxrFile, type WxrItem, type WxrTerm } from '../src/import/wxr'

const argv = process.argv.slice(2)
const val = (n: string): string | undefined => {
  const i = argv.indexOf(n)
  const v = i >= 0 ? argv[i + 1] : undefined
  return v !== undefined && v.startsWith('--') ? undefined : v
}
const file = val('--file')
if (!file) {
  console.error('usage: --file <export.xml> [--rules <rules.json>] [--detail-file <csv>]')
  process.exit(2)
}
const rulesFile = val('--rules')
const detailFile = val('--detail-file')
for (const f of [rulesFile, detailFile]) {
  if (f && isInsideRepo(path.resolve(f), process.cwd())) {
    console.error('PATH_INSIDE_REPO')
    process.exit(2)
  }
}
if (detailFile && fs.existsSync(detailFile)) {
  console.error('DETAIL_FILE_EXISTS')
  process.exit(2)
}
let ruleSet = DEFAULT_CATEGORY_RULES
if (rulesFile) {
  const parsed = parseCategoryRules(fs.readFileSync(rulesFile, 'utf8').replace(/^﻿/, ''))
  if (!parsed) {
    console.error('RULES_INVALID')
    process.exit(2)
  }
  ruleSet = parsed
}
const rules = compileRules(ruleSet)

const byId = new Map<number, WxrTerm>()
const byNic = new Map<string, WxrTerm>()
const era = new EraIndex()
const labelled: { item: WxrItem; truth: string }[] = []
const target: { item: WxrItem }[] = []
for await (const rec of readWxrFile(file)) {
  if (rec.record === 'category') {
    const t = { name: rec.category.name, nicename: rec.category.nicename }
    if (rec.category.termId !== null) byId.set(rec.category.termId, t)
    byNic.set(t.nicename, t)
  }
  if (rec.record !== 'item') continue
  const it = rec.item
  if (it.kind !== 'post' || it.status !== 'publish' || it.hasPassword || it.wpId === null) continue
  const chain = chooseCategoryChain({ categories: it.categories, tags: it.tags, primaryCategory: it.seo.yoastPrimaryCategory }, { byTermId: byId, byNicename: byNic, tagMap: {} })
  if (chain.step === 'wordpress' || chain.step === 'yoast-primary') {
    labelled.push({ item: it, truth: chain.term!.nicename })
    era.add(it.dateGmt, chain.term!.nicename)
  } else target.push({ item: it })
}
const run = (it: WxrItem, leaveOut?: string): Classification =>
  classify({ title: it.title, excerpt: textForClassification(it.excerptHtml), body: textForClassification(it.contentHtml), dateGmt: it.dateGmt, leaveOut }, rules, era)

const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n)
const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a')

const vres = labelled.map((l) => ({ truth: l.truth, cls: run(l.item, l.truth) }))
const confident = vres.filter((l) => l.cls.confident)
const right = confident.filter((l) => l.cls.category === l.truth)
console.log('VALIDATION (posts that already have a category, own category hidden)')
console.log(`  posts: ${vres.length}; confident: ${confident.length} (${pct(confident.length, vres.length)}); correct among confident: ${right.length} (precision ${pct(right.length, confident.length)})`)
const tally = (key: (l: (typeof vres)[number]) => string) => {
  const m = new Map<string, [number, number]>()
  for (const l of confident) {
    const e = m.get(key(l)) ?? [0, 0]
    e[0]++
    if (l.cls.category === l.truth) e[1]++
    m.set(key(l), e)
  }
  return [...m.entries()].sort((a, b) => b[1][0] - a[1][0] || (a[0] < b[0] ? -1 : 1))
}
console.log('  by winning rule (confident, correct, precision):')
for (const [k, [n, c]] of tally((l) => l.cls.ruleId as string)) console.log(`    ${k}: ${n}, ${c}, ${pct(c, n)}`)
console.log('  by predicted category (confident, correct, precision):')
for (const [k, [n, c]] of tally((l) => l.cls.category as string)) console.log(`    ${k}: ${n}, ${c}, ${pct(c, n)}`)
const trueCount = new Map<string, number>()
const hit = new Map<string, number>()
for (const l of vres) {
  bump(trueCount, l.truth)
  if (l.cls.confident && l.cls.category === l.truth) bump(hit, l.truth)
}
console.log('  recall by true category (correct confident of posts):')
for (const [k, n] of sorted(trueCount)) console.log(`    ${k}: ${hit.get(k) ?? 0} of ${n}`)

const tres = target.map((t) => ({ id: t.item.wpId as number, cls: run(t.item) }))
const tConf = tres.filter((t) => t.cls.confident)
console.log('TARGET (posts that would fall to the fallback category)')
console.log(`  posts: ${tres.length}; confident category: ${tConf.length}; remain fallback: ${tres.length - tConf.length}`)
const dist = new Map<string, number>()
for (const t of tConf) bump(dist, t.cls.category as string)
console.log('  distribution of confident categories:')
for (const [k, n] of sorted(dist)) console.log(`    ${k}: ${n}`)
const byRule = new Map<string, number>()
for (const t of tConf) bump(byRule, t.cls.ruleId as string)
console.log('  confident by winning rule:')
for (const [k, n] of sorted(byRule)) console.log(`    ${k}: ${n}`)
console.log(`  nothing matched at all: ${tres.filter((t) => !t.cls.category).length}`)

if (detailFile) {
  const lines = ['legacy_id,suggested_category,score,runner_up,runner_up_score,confident']
  for (const t of tres) lines.push([t.id, t.cls.category ?? '', t.cls.score, t.cls.runnerUp ?? '', t.cls.runnerUpScore, t.cls.confident ? 'yes' : 'no'].join(','))
  fs.mkdirSync(path.dirname(detailFile), { recursive: true })
  fs.writeFileSync(detailFile, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  console.log(`  detail rows written: ${tres.length}`)
}
