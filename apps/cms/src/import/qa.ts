/**
 * Post-import QA report. Counts and reason codes only: no title, slug, address, file name, author name, comment text
 * or email ever enters this structure (every key written to it is a fixed code or comes from a closed set, and the
 * only values are numbers). `formatImportReport` prints it; `import.md` documents the fields.
 */

export type Tally = Record<string, number>

export type ImportReport = {
  mode: 'dry-run' | 'apply'
  update: boolean
  source: {
    items: Tally
    postsByStatus: Tally
    publishedPosts: number
    approvedCommentsOnPublishedPosts: number
    attachments: number
  }
  articles: {
    created: number
    updated: number
    /** Already present (same legacyId) and left alone. */
    unchanged: number
    /** Everything not imported, by reason: password-protected, status-<x>, bad-id, no-date, conversion-<code>, write-failed, ... */
    skipped: Tally
    passwordProtected: number
    /** Imported before, but the post is now draft, private, trashed ...: left as it is in the CMS. */
    previouslyImportedNowNotPublished: number
  }
  categories: { created: number; fallbackUsed: number }
  media: { reused: number; created: number; unresolved: Tally }
  content: {
    imagesResolved: number
    /** Images in article bodies that could not be resolved (turned into text). */
    imagesUnresolved: number
    linksUnmapped: number
    featuredImageMissing: number
    youtube: number
    tablesFlattened: number
    embedsDropped: number
  }
  comments: { created: number; existing: number; skipped: Tally; orphanedParents: number; truncated: number }
  /** Rows now in the database for the legacy ids seen in this run; undefined in a dry run. */
  verified?: { articlesInDatabase: number; commentsInDatabase: number }
  /** Short, fixed-vocabulary notes (for example `manifest-written`). */
  notes: string[]
}

const t = (): Tally => ({})

export function newReport(mode: 'dry-run' | 'apply', update: boolean): ImportReport {
  return {
    mode,
    update,
    source: { items: t(), postsByStatus: t(), publishedPosts: 0, approvedCommentsOnPublishedPosts: 0, attachments: 0 },
    articles: { created: 0, updated: 0, unchanged: 0, skipped: t(), passwordProtected: 0, previouslyImportedNowNotPublished: 0 },
    categories: { created: 0, fallbackUsed: 0 },
    media: { reused: 0, created: 0, unresolved: t() },
    content: { imagesResolved: 0, imagesUnresolved: 0, linksUnmapped: 0, featuredImageMissing: 0, youtube: 0, tablesFlattened: 0, embedsDropped: 0 },
    comments: { created: 0, existing: 0, skipped: t(), orphanedParents: 0, truncated: 0 },
    notes: [],
  }
}

const KNOWN_STATUSES = new Set(['publish', 'draft', 'private', 'pending', 'future', 'trash', 'auto-draft', 'inherit'])

/** Report keys come from a closed set: a status the file invents becomes `other`. */
export const statusKey = (status: string): string => (KNOWN_STATUSES.has(status) ? status : 'other')

export const bumpTally = (tally: Tally, key: string, by = 1): void => {
  tally[key] = (tally[key] ?? 0) + by
}

const sum = (tally: Tally): number => Object.values(tally).reduce((a, b) => a + b, 0)

/** Reconciliation lines: source published posts against what happened to them. */
export function reconcile(rep: ImportReport): { sourcePublished: number; accountedFor: number; difference: number } {
  const imported = rep.articles.created + rep.articles.updated + rep.articles.unchanged
  const skippedPublished = sum(
    Object.fromEntries(Object.entries(rep.articles.skipped).filter(([k]) => !k.startsWith('status-'))),
  )
  const accountedFor = imported + rep.articles.passwordProtected + skippedPublished
  return { sourcePublished: rep.source.publishedPosts, accountedFor, difference: rep.source.publishedPosts - accountedFor }
}

const lines = (title: string, tally: Tally): string[] => {
  const keys = Object.keys(tally).sort()
  return keys.length === 0 ? [`${title}: none`] : [`${title}:`, ...keys.map((k) => `  ${k}: ${tally[k]}`)]
}

export function formatImportReport(rep: ImportReport): string {
  const rec = reconcile(rep)
  const out: string[] = [
    `Import report (${rep.mode}${rep.update ? ', update existing' : ''})`,
    '',
    'Source',
    ...lines('  items by kind', rep.source.items),
    ...lines('  posts by status', rep.source.postsByStatus),
    `  published posts: ${rep.source.publishedPosts}`,
    `  approved comments on published posts: ${rep.source.approvedCommentsOnPublishedPosts}`,
    `  attachments: ${rep.source.attachments}`,
    '',
    'Articles',
    `  created: ${rep.articles.created}`,
    `  updated: ${rep.articles.updated}`,
    `  unchanged (already imported): ${rep.articles.unchanged}`,
    `  password-protected (skipped): ${rep.articles.passwordProtected}`,
    ...lines('  skipped by reason', rep.articles.skipped),
    `  published posts accounted for: ${rec.accountedFor} of ${rec.sourcePublished} (difference ${rec.difference})`,
    `  previously imported, now not published in the export (left alone): ${rep.articles.previouslyImportedNowNotPublished}`,
    '',
    'Categories',
    `  created: ${rep.categories.created}`,
    `  articles placed in the fallback category: ${rep.categories.fallbackUsed}`,
    '',
    'Media',
    `  reused: ${rep.media.reused}`,
    `  ${rep.mode === 'dry-run' ? 'would be created' : 'created'}: ${rep.media.created}`,
    ...lines('  unresolved by reason', rep.media.unresolved),
    '',
    'Content',
    `  images resolved: ${rep.content.imagesResolved}`,
    `  images unresolved (now text): ${rep.content.imagesUnresolved}`,
    `  links unmapped: ${rep.content.linksUnmapped}`,
    `  articles without a featured image where one was expected: ${rep.content.featuredImageMissing}`,
    `  YouTube embeds: ${rep.content.youtube}`,
    `  tables flattened: ${rep.content.tablesFlattened}`,
    `  embeds dropped: ${rep.content.embedsDropped}`,
    '',
    'Comments',
    `  ${rep.mode === 'dry-run' ? 'would be created' : 'created'}: ${rep.comments.created}`,
    `  already present: ${rep.comments.existing}`,
    `  parent not imported (made top-level): ${rep.comments.orphanedParents}`,
    `  cut to the length cap: ${rep.comments.truncated}`,
    ...lines('  skipped by reason', rep.comments.skipped),
  ]
  if (rep.verified) {
    out.push('', 'Database check', `  articles with these legacy ids: ${rep.verified.articlesInDatabase}`, `  comments for them: ${rep.verified.commentsInDatabase}`)
  }
  if (rep.notes.length) out.push('', ...rep.notes.map((n) => `note: ${n}`))
  return out.join('\n')
}
