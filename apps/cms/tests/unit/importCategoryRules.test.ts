import { describe, expect, it } from 'vitest'

import { parseImportArgs } from '../../src/import/cli'
import {
  classify,
  compileRules,
  EraIndex,
  ERA_RULE_ID,
  monthIndex,
  normalise,
  parseCategoryRules,
  textForClassification,
  type CategoryRuleSet,
} from '../../src/import/categoryRules'
import { DEFAULT_CATEGORY_RULES } from '../../src/import/categoryRulesDefault'
import { chooseCategoryChain, type CategoryLookups } from '../../src/import/mapping'

const t = (nicename: string) => ({ nicename, name: nicename })
const input = (title: string, body = '', excerpt = '', dateGmt: string | null = null) => ({ title, excerpt, body, dateGmt })

const SET: CategoryRuleSet = {
  minScore: 6,
  minMargin: 3,
  rules: [
    { id: 'r.interview', category: 'interviews', patterns: [{ phrase: 'interview*', weight: 3 }] },
    { id: 'r.mission', category: 'missions', patterns: [{ phrase: 'mission field', weight: 3 }, { phrase: 'missionar*', weight: 2 }] },
    { id: 'r.mission2', category: 'missions', patterns: [{ phrase: 'unreached', weight: 2 }] },
  ],
}
const rules = compileRules(SET)

describe('normalise and text', () => {
  it('lowercases, drops apostrophes, collapses punctuation and pads', () => {
    expect(normalise("Publisher's  Note: Q&A!")).toBe(' publishers note q a ')
    expect(normalise('')).toBe(' ')
  })
  it('strips tags, shortcodes and entities and truncates', () => {
    expect(textForClassification('<p>Hello&nbsp;<b>world</b>[caption id=1]x[/caption]</p>').replace(/\s+/g, ' ').trim()).toBe('Hello world x')
    expect(textForClassification('a'.repeat(50_000)).length).toBeLessThanOrEqual(8000)
  })
})

describe('classify', () => {
  it('scores the title above the excerpt above the body and honours the thresholds', () => {
    // title 3*3=9 -> confident
    const title = classify(input('An interview with a bishop'), rules)
    expect(title).toMatchObject({ category: 'interviews', ruleId: 'r.interview', score: 9, confident: true })
    // excerpt 3*2=6 -> confident at the limit
    expect(classify(input('Plain', '', 'interview notes'), rules)).toMatchObject({ score: 6, confident: true })
    // body counts 0.5 each, at most twice: 3 -> not confident, but still suggested
    const body = classify(input('Plain', 'interview interview interview'), rules)
    expect(body).toMatchObject({ category: 'interviews', score: 3, confident: false })
  })
  it('matches whole words, with a trailing star meaning a prefix', () => {
    expect(classify(input('The interviewer spoke'), rules).category).toBe('interviews')
    expect(classify(input('Unreachable hills', '', ''), rules).category).toBeUndefined()
    expect(classify(input('Unreached peoples and the mission field'), rules).category).toBe('missions')
  })
  it('sums the rules of one category and reports the best rule, the runner-up and its score', () => {
    const c = classify(input('The mission field and the unreached', 'an interview'), rules)
    expect(c.category).toBe('missions')
    expect(c.ruleId).toBe('r.mission') // 9 beats 6 inside the category
    expect(c.score).toBe(15)
    expect(c).toMatchObject({ runnerUp: 'interviews', runnerUpScore: 1.5, confident: true })
  })
  it('needs a margin over the runner-up', () => {
    const c = classify(input('An interview about the mission field'), rules)
    expect(c.confident).toBe(false) // 9 against 9
    expect(c.score).toBe(9)
    expect(c.runnerUpScore).toBe(9)
  })
  it('breaks equal totals by the order of the rules, deterministically', () => {
    const a = classify(input('interview and mission field'), rules)
    const b = classify(input('interview and mission field'), rules)
    expect(a).toEqual(b)
    expect(a.category).toBe('interviews') // listed first
  })
  it('returns nothing for text that matches no rule', () => {
    expect(classify(input('Nothing here'), rules)).toEqual({ category: undefined, ruleId: undefined, score: 0, runnerUp: undefined, runnerUpScore: 0, confident: false })
  })
  it('is idempotent: the same inputs always give the same output', () => {
    const era = new EraIndex()
    for (let i = 0; i < 12; i++) era.add('2021-03-10T00:00:00.000Z', 'interviews')
    const withEra = compileRules({ ...SET, neighbours: { windowMonths: 1, minPosts: 5, weight: 10, maxWindowMonths: 4, smoothing: 0 } })
    const x = input('Some story', 'about a mission field', '', '2021-03-20T00:00:00.000Z')
    const first = classify(x, withEra, era)
    for (let i = 0; i < 5; i++) expect(classify(x, withEra, era)).toEqual(first)
  })
})

describe('neighbour evidence', () => {
  const nb = { windowMonths: 1, minPosts: 5, weight: 10, maxWindowMonths: 4, smoothing: 0 }
  const withNb = compileRules({ ...SET, neighbours: nb })
  const post = (date: string) => input('A story', '', '', date)

  it('turns the categories of nearby posts into a score', () => {
    const era = new EraIndex()
    for (let i = 0; i < 8; i++) era.add('2020-06-01T00:00:00.000Z', 'interviews')
    for (let i = 0; i < 2; i++) era.add('2020-07-01T00:00:00.000Z', 'missions')
    const c = classify(post('2020-06-15T00:00:00.000Z'), withNb, era)
    expect(c).toMatchObject({ category: 'interviews', ruleId: ERA_RULE_ID, score: 8, runnerUp: 'missions', runnerUpScore: 2, confident: true })
  })
  it('widens a sparse window (doubling) up to the maximum, then gives up', () => {
    const era = new EraIndex()
    for (let i = 0; i < 6; i++) era.add('2020-01-01T00:00:00.000Z', 'missions')
    // 3 months away: window 1 empty, window 2 empty, window 4 reaches it
    expect(classify(post('2020-04-15T00:00:00.000Z'), withNb, era).category).toBe('missions')
    // 10 months away: beyond the maximum of 4
    expect(classify(post('2020-11-15T00:00:00.000Z'), withNb, era).category).toBeUndefined()
  })
  it('shrinks small samples with the smoothing term and needs minPosts', () => {
    const era = new EraIndex()
    for (let i = 0; i < 5; i++) era.add('2020-06-01T00:00:00.000Z', 'missions')
    const smooth = compileRules({ ...SET, neighbours: { ...nb, smoothing: 5 } })
    expect(classify(post('2020-06-01T00:00:00.000Z'), smooth, era)).toMatchObject({ score: 5, confident: false })
    const era2 = new EraIndex()
    for (let i = 0; i < 4; i++) era2.add('2020-06-01T00:00:00.000Z', 'missions')
    expect(classify(post('2020-06-01T00:00:00.000Z'), withNb, era2).category).toBeUndefined()
  })
  it('ignores posts without a usable date and can leave one vote out (evaluation)', () => {
    const era = new EraIndex()
    era.add(null, 'missions')
    era.add('not a date', 'missions')
    expect(monthIndex('2020-06-01T00:00:00.000Z')).toBe(2020 * 12 + 5)
    expect(era.votes('2020-06-01T00:00:00.000Z', 3).total).toBe(0)
    for (let i = 0; i < 6; i++) era.add('2020-06-01T00:00:00.000Z', 'missions')
    expect(era.votes('2020-06-01T00:00:00.000Z', 0).total).toBe(6)
    expect(era.votes('2020-06-01T00:00:00.000Z', 0, 'missions').total).toBe(5)
  })
  it('lets explicit words and neighbours add up', () => {
    const era = new EraIndex()
    for (let i = 0; i < 10; i++) era.add('2020-06-01T00:00:00.000Z', 'missions')
    const c = classify(input('An interview', '', '', '2020-06-02T00:00:00.000Z'), withNb, era)
    // missions: 10; interviews: 9 -> margin 1 -> not confident
    expect(c).toMatchObject({ category: 'missions', confident: false, runnerUp: 'interviews', runnerUpScore: 9 })
  })
})

describe('default rules', () => {
  it('compile and are valid by the same checks as a rules file', () => {
    expect(parseCategoryRules(JSON.stringify(DEFAULT_CATEGORY_RULES))).toEqual(DEFAULT_CATEGORY_RULES)
  })
  it('place an explicit cue in the title', () => {
    const r = compileRules(DEFAULT_CATEGORY_RULES)
    expect(classify(input('Special report: the road ahead'), r)).toMatchObject({ category: 'special-report', confident: true })
    expect(classify(input("Publisher's note for the new year"), r)).toMatchObject({ category: 'publishers-note', confident: true })
  })
})

describe('parseCategoryRules', () => {
  const ok = { minScore: 5, minMargin: 2, rules: [{ id: 'a.b', category: 'news', patterns: [{ phrase: 'synod', weight: 2 }] }] }
  it('accepts a valid file', () => {
    expect(parseCategoryRules(JSON.stringify(ok))).toEqual(ok)
    expect(parseCategoryRules(JSON.stringify({ ...ok, neighbours: { windowMonths: 2, minPosts: 5, weight: 10, maxWindowMonths: 8, smoothing: 1 } }))?.neighbours?.maxWindowMonths).toBe(8)
  })
  it.each([
    ['not json', 'nope'],
    ['an array', '[]'],
    ['no rules and no neighbours', JSON.stringify({ minScore: 1, minMargin: 1, rules: [] })],
    ['negative score', JSON.stringify({ ...ok, minScore: -1 })],
    ['bad category slug', JSON.stringify({ ...ok, rules: [{ ...ok.rules[0], category: 'Not A Slug' }] })],
    ['reserved id', JSON.stringify({ ...ok, rules: [{ ...ok.rules[0], id: ERA_RULE_ID }] })],
    ['duplicate id', JSON.stringify({ ...ok, rules: [ok.rules[0], ok.rules[0]] })],
    ['empty phrase', JSON.stringify({ ...ok, rules: [{ ...ok.rules[0], patterns: [{ phrase: '*', weight: 1 }] }] })],
    ['zero weight', JSON.stringify({ ...ok, rules: [{ ...ok.rules[0], patterns: [{ phrase: 'x', weight: 0 }] }] })],
    ['window above maximum', JSON.stringify({ ...ok, neighbours: { windowMonths: 9, minPosts: 5, weight: 1, maxWindowMonths: 3, smoothing: 0 } })],
    ['proto key is not a field', JSON.stringify({ ...ok, rules: [{ id: 'x', category: 'news', patterns: [{ phrase: 'a', weight: 'heavy' }] }] })],
  ])('refuses %s', (_name, text) => {
    expect(parseCategoryRules(text)).toBeUndefined()
  })
})

describe('the category chain with rules', () => {
  const byNicename = new Map([
    ['news', t('news')],
    ['interviews', t('interviews')],
    ['missions', t('missions')],
    ['uncategorised', t('uncategorised')],
  ])
  const lookups: CategoryLookups = { byTermId: new Map([[7, t('missions')]]), byNicename, tagMap: { 'a-tag': 'news' } }
  const sure = { category: 'interviews', ruleId: 'r.interview', score: 9, runnerUp: 'news', runnerUpScore: 1, confident: true }
  const unsure = { ...sure, score: 2, confident: false }
  const base = { categories: [], tags: [], primaryCategory: null }

  it('strict mode (no classifier) is the previous behaviour', () => {
    expect(chooseCategoryChain(base, lookups)).toMatchObject({ step: 'fallback' })
    expect(chooseCategoryChain({ ...base, categories: [t('uncategorised')] }, lookups)).toMatchObject({ step: 'generic' })
  })
  it('rules apply only after the WordPress category, the Yoast primary and the tag map', () => {
    const classify = () => sure
    expect(chooseCategoryChain({ ...base, categories: [t('news')], classify }, lookups)).toMatchObject({ step: 'wordpress' })
    expect(chooseCategoryChain({ ...base, primaryCategory: '7', classify }, lookups)).toMatchObject({ step: 'yoast-primary' })
    expect(chooseCategoryChain({ ...base, tags: [t('a-tag')], classify }, lookups)).toMatchObject({ step: 'tag-map' })
    const r = chooseCategoryChain({ ...base, classify }, lookups)
    expect(r).toMatchObject({ step: 'rules', term: { nicename: 'interviews' }, mustExist: false, rule: sure })
  })
  it('a confident rule also replaces the generic Uncategorised', () => {
    expect(chooseCategoryChain({ ...base, categories: [t('uncategorised')], classify: () => sure }, lookups)).toMatchObject({ step: 'rules' })
  })
  it('a rule target that is not an exported category must already exist', () => {
    const r = chooseCategoryChain({ ...base, classify: () => ({ ...sure, category: 'health' }) }, lookups)
    expect(r).toMatchObject({ step: 'rules', mustExist: true, term: { nicename: 'health' } })
  })
  it('a low-confidence answer is kept as a suggestion on the fallback, never used', () => {
    expect(chooseCategoryChain({ ...base, classify: () => unsure }, lookups)).toMatchObject({ step: 'fallback', term: undefined, rule: unsure })
    expect(chooseCategoryChain({ ...base, categories: [t('uncategorised')], classify: () => unsure }, lookups)).toMatchObject({ step: 'generic', rule: unsure })
  })
  it('never targets the generic category', () => {
    expect(chooseCategoryChain({ ...base, classify: () => ({ ...sure, category: 'uncategorised' }) }, lookups)).toMatchObject({ step: 'fallback' })
  })
})

describe('import options', () => {
  const parse = (...a: string[]) => parseImportArgs(['--file', '/x/e.xml', ...a], {})
  it('defaults to the strict mode', () => {
    expect(parse()?.categoryMode).toBeUndefined()
    expect(parse('--category-mode=strict')?.categoryMode).toBe('strict')
  })
  it('reads the rules mode, the rules file and the review file', () => {
    expect(parse('--category-mode=rules', '--category-rules', '/p/r.json', '--category-review', '/p/r.csv')).toMatchObject({
      categoryMode: 'rules',
      categoryRulesFile: '/p/r.json',
      categoryReviewFile: '/p/r.csv',
    })
    expect(parse('--category-mode', 'rules')?.categoryMode).toBe('rules')
  })
  it('refuses a bad mode, a repeated mode and a missing value', () => {
    expect(parse('--category-mode=magic')).toBeNull()
    expect(parse('--category-mode=rules', '--category-mode=strict')).toBeNull()
    expect(parse('--category-rules')).toBeNull()
  })
  it('keeps the fallback category default (News) and lets it be configured', () => {
    expect(parse()?.fallbackCategory).toBeUndefined()
    expect(parse('--fallback-category', 'general', '--fallback-category-name', 'General')?.fallbackCategory).toEqual({ slug: 'general', title: 'General' })
  })
})
