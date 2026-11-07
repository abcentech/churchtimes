import type { CategoryRuleSet } from './categoryRules'

/**
 * Default rules for the 15 categories of the Church Times Nigeria export. Phrases are plain words (see categoryRules.ts).
 * Replace wholesale with `--category-rules <rules.json outside the repo>`.
 *
 * Measured on the real export (docs/import.md): the archive's categories follow editorial eras (missions until 2017, then mostly
 * interviews and missions, mostly news from 2024) and NOT topics, so topical words (health, education, business, gospel ...)
 * predicted the existing categories badly and are not used. The evidence is the neighbouring posts' categories, plus a few
 * explicit cues that name the category itself.
 */
const p = (phrase: string, weight = 1) => ({ phrase, weight })

export const DEFAULT_CATEGORY_RULES: CategoryRuleSet = {
  minScore: 6,
  minMargin: 3,
  neighbours: { windowMonths: 2, minPosts: 6, weight: 10, maxWindowMonths: 32, smoothing: 2 },
  rules: [
    { id: 'cue.interview', category: 'interviews', patterns: [p('interview*', 3), p('in conversation with', 4), p('q a', 3)] },
    { id: 'cue.publishers-note', category: 'publishers-note', patterns: [p('publishers note', 6), p('from the publisher', 4), p('publishers desk', 4)] },
    { id: 'cue.opinion', category: 'opinion', patterns: [p('opinion', 3), p('editorial', 3), p('in my opinion', 3)] },
    { id: 'cue.advertorial', category: 'advertorial', patterns: [p('advertorial', 8), p('sponsored content', 6)] },
    { id: 'cue.book-review', category: 'book-review', patterns: [p('book review', 6), p('reviewed by', 3)] },
    { id: 'cue.special-report', category: 'special-report', patterns: [p('special report', 8)] },
  ],
}
