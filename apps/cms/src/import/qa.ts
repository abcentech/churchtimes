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
    /** Posts whose WordPress slug is a reserved route name (admin, search, ...) and got a numbered slug instead (root article paths). */
    slugRenamedReserved: number
    /** Imported before, but the post is now draft, private, trashed ...: left as it is in the CMS. */
    previouslyImportedNowNotPublished: number
  }
  /**
   * Articles.category is ONE required relationship, so only one WordPress category per post is kept.
   * `postsWithExtraCategories` / `extraCategoriesDropped` size what the schema cannot hold.
   */
  categories: {
    created: number
    /** Articles that ended in the configured fallback category or kept the generic WordPress "Uncategorised". */
    fallbackUsed: number
    postsWithExtraCategories: number
    extraCategoriesDropped: number
    /** Where each created article's category came from (the chain: WordPress, Yoast primary, tag map, generic, fallback). */
    bySource: { wordpress: number; yoastPrimary: number; tagMap: number; rules: number; generic: number; fallback: number }
    /** Rules mode: posts left in the fallback with a low-confidence suggestion (listed in the review file when one is given). */
    rulesLowConfidence: number
    /** The category mode of this run. */
    mode: 'strict' | 'rules'
    /** Posts naming a Yoast primary category that is not a category of the export. */
    yoastPrimaryUnresolved: number
    /** Tag-map entries whose target category does not exist (nothing is created from a tag): the next step applied. */
    tagMapTargetMissing: number
  }
  /** SEO text (Articles.seoTitle / seoDescription) for articles written in this run, by source. Counts only. */
  seo: {
    titleFrom: { rankMath: number; yoast: number; none: number }
    descriptionFrom: { rankMath: number; yoast: number; none: number }
    /** Values whose variables (%title%, %%sitename%% ...) were substituted or removed. */
    variablesResolved: number
    /** Values dropped because a variable text was still present after resolution. */
    droppedUnresolved: number
    /** Values cut to the schema limit. */
    truncated: number
    /** Yoast values the schema has no field for: counted, not stored. */
    yoastCanonicalValid: number
    yoastCanonicalInvalid: number
    yoastNoindex: number
    yoastSocial: number
  }
  /** Bylines are text only (Articles.bylineName); no user account is ever created. Counts of distinct `dc:creator` values. */
  authors: { distinct: number; withByline: number; unmapped: number; postsWithoutByline: number }
  media: { reused: number; created: number; unresolved: Tally }
  content: {
    imagesResolved: number
    /** Images in article bodies that could not be resolved (turned into text). */
    imagesUnresolved: number
    linksUnmapped: number
    featuredImageMissing: number
    /** Featured images resolved to a media document, and those refused by the safety or media rules (also in `media.unresolved`). */
    featuredImageResolved: number
    featuredImageRejected: number
    youtube: number
    /** Audio/video blocks written with a media file. */
    avResolved: number
    /** Audio/video blocks kept with the legacy address because the file was not found (reason code `unresolved-media`). */
    avUnresolvedMedia: number
    /** Audio/video of a type the CMS does not host (linked or dropped). */
    avUnsupported: number
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
    articles: { created: 0, updated: 0, unchanged: 0, skipped: t(), passwordProtected: 0, previouslyImportedNowNotPublished: 0, slugRenamedReserved: 0 },
    categories: {
      created: 0,
      fallbackUsed: 0,
      postsWithExtraCategories: 0,
      extraCategoriesDropped: 0,
      bySource: { wordpress: 0, yoastPrimary: 0, tagMap: 0, rules: 0, generic: 0, fallback: 0 },
      rulesLowConfidence: 0,
      mode: 'strict',
      yoastPrimaryUnresolved: 0,
      tagMapTargetMissing: 0,
    },
    seo: {
      titleFrom: { rankMath: 0, yoast: 0, none: 0 },
      descriptionFrom: { rankMath: 0, yoast: 0, none: 0 },
      variablesResolved: 0,
      droppedUnresolved: 0,
      truncated: 0,
      yoastCanonicalValid: 0,
      yoastCanonicalInvalid: 0,
      yoastNoindex: 0,
      yoastSocial: 0,
    },
    authors: { distinct: 0, withByline: 0, unmapped: 0, postsWithoutByline: 0 },
    media: { reused: 0, created: 0, unresolved: t() },
    content: { imagesResolved: 0, imagesUnresolved: 0, linksUnmapped: 0, featuredImageMissing: 0, featuredImageResolved: 0, featuredImageRejected: 0, youtube: 0, avResolved: 0, avUnresolvedMedia: 0, avUnsupported: 0, tablesFlattened: 0, embedsDropped: 0 },
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
    `  slug is a reserved route name, renamed with the post id: ${rep.articles.slugRenamedReserved}`,
    '',
    'Categories',
    `  created: ${rep.categories.created}`,
    `  articles placed in the fallback category (or kept as WordPress "Uncategorised"): ${rep.categories.fallbackUsed}`,
    `  category source: WordPress ${rep.categories.bySource.wordpress}, Yoast primary ${rep.categories.bySource.yoastPrimary}, tag map ${rep.categories.bySource.tagMap}, rules ${rep.categories.bySource.rules}, generic ${rep.categories.bySource.generic}, fallback ${rep.categories.bySource.fallback}`,
    `  category mode: ${rep.categories.mode}${rep.categories.mode === 'rules' ? `; low-confidence suggestions left in the fallback: ${rep.categories.rulesLowConfidence}` : ''}`,
    `  Yoast primary category not in the export: ${rep.categories.yoastPrimaryUnresolved}; tag-map targets that do not exist: ${rep.categories.tagMapTargetMissing}`,
    `  posts with more categories than the schema holds (one): ${rep.categories.postsWithExtraCategories} (${rep.categories.extraCategoriesDropped} extra categories not kept)`,
    '',
    'SEO text (articles written in this run)',
    `  title from: Rank Math ${rep.seo.titleFrom.rankMath}, Yoast ${rep.seo.titleFrom.yoast}, none ${rep.seo.titleFrom.none}`,
    `  description from: Rank Math ${rep.seo.descriptionFrom.rankMath}, Yoast ${rep.seo.descriptionFrom.yoast}, none ${rep.seo.descriptionFrom.none}`,
    `  values with variables resolved: ${rep.seo.variablesResolved}; dropped (variable left over): ${rep.seo.droppedUnresolved}; cut to the limit: ${rep.seo.truncated}`,
    `  Yoast values with no field in the schema (not stored): canonical valid ${rep.seo.yoastCanonicalValid}, canonical invalid ${rep.seo.yoastCanonicalInvalid}, noindex ${rep.seo.yoastNoindex}, social text ${rep.seo.yoastSocial}`,
    '',
    'Authors (byline text only, no accounts created)',
    `  distinct authors: ${rep.authors.distinct}`,
    `  with a byline: ${rep.authors.withByline}`,
    `  unmapped (no usable name): ${rep.authors.unmapped}`,
    `  posts left without a byline: ${rep.authors.postsWithoutByline}`,
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
    `  featured images resolved: ${rep.content.featuredImageResolved}`,
    `  featured images rejected (unsafe or refused by the media rules): ${rep.content.featuredImageRejected}`,
    `  articles without a featured image where one was expected: ${rep.content.featuredImageMissing}`,
    `  YouTube embeds: ${rep.content.youtube}`,
    `  audio/video blocks: ${rep.content.avResolved} with a file, ${rep.content.avUnresolvedMedia} unresolved-media (legacy address kept), ${rep.content.avUnsupported} unsupported type`,
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
