/**
 * Seed script: `npm run seed` (runs `payload run src/seed/index.ts`).
 *
 * Idempotent: every record is upserted (categories by slug, articles by legacyId or slug,
 * users by email, live event by slug), so re-running never duplicates content.
 *
 * Env:
 *   DATABASE_URL, PAYLOAD_SECRET   required, as for the app (see .env.example)
 *   SEED_STORIES_PATH              optional override for the legacy stories.json
 *   SEED_DEMO_USERS=true           also create demo users and a draft demo live event
 *                                  (ignored when NODE_ENV=production)
 *   SEED_DEMO_PASSWORD             required with SEED_DEMO_USERS=true; at least 12 characters
 *
 * Not seeded: images. Legacy images are NOT uploaded to media; importing them is a future
 * migration step that needs a rights review first.
 */
import config from '@payload-config'
import { getPayload, type Payload } from 'payload'

import { seedDemoLiveEvent, seedDemoUsers, readDemoPassword, type Counts } from './demo'
import { paragraphsToLexical } from './lexical'
import { loadStories, type Story } from './stories'

const SEED_CONTEXT = { seed: true } as const

const CATEGORIES: { title: string; slug: string }[] = [
  { title: 'News', slug: 'news' },
  { title: 'Features', slug: 'features' },
  { title: 'Opinion', slug: 'opinion' },
  { title: 'Columnists', slug: 'columnists' },
  { title: 'Interviews', slug: 'interviews' },
  { title: 'Business', slug: 'business' },
  { title: 'Education', slug: 'education' },
  { title: 'Health', slug: 'health' },
  { title: "Publisher's Note", slug: 'publishers-note' },
]

const TITLE_MAX = 240
const SUMMARY_MAX = 600

/** Normalize a category title for lookup: NFKC, straight apostrophes, collapsed spaces, lowercase. */
const categoryKey = (title: string): string =>
  title.normalize('NFKC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()

const newCounts = (): Counts => ({ created: 0, updated: 0 })

async function upsertCategories(payload: Payload, counts: Counts): Promise<Map<string, number>> {
  const idBySlug = new Map<string, number>()

  for (const cat of CATEGORIES) {
    const existing = await payload.find({
      collection: 'categories',
      where: { slug: { equals: cat.slug } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })

    if (existing.docs[0]) {
      const doc = await payload.update({
        collection: 'categories',
        id: existing.docs[0].id,
        data: { title: cat.title },
        depth: 0,
        overrideAccess: true,
        context: SEED_CONTEXT,
      })
      idBySlug.set(cat.slug, doc.id)
      counts.updated += 1
    } else {
      const doc = await payload.create({
        collection: 'categories',
        data: { title: cat.title, slug: cat.slug },
        depth: 0,
        overrideAccess: true,
        context: SEED_CONTEXT,
      })
      idBySlug.set(cat.slug, doc.id)
      counts.created += 1
    }
  }
  return idBySlug
}

async function upsertArticle(
  payload: Payload,
  story: Story,
  categoryId: number,
  counts: Counts,
): Promise<void> {
  if (Number.isNaN(Date.parse(story.dateGMT))) {
    throw new Error(`Story ${story.slug}: invalid dateGMT "${story.dateGMT}".`)
  }
  if (story.title.length > TITLE_MAX) {
    throw new Error(`Story ${story.slug}: title exceeds ${TITLE_MAX} characters.`)
  }

  const summary = (story.summary ?? '').trim()
  const data = {
    title: story.title,
    slug: story.slug,
    excerpt: summary ? summary.slice(0, SUMMARY_MAX) : undefined,
    content: paragraphsToLexical(story.briefing.length > 0 ? story.briefing : [summary]),
    category: categoryId,
    bylineName: story.author,
    legacyUrl: story.source,
    legacyId: story.id,
  }

  const existing = await payload.find({
    collection: 'articles',
    where: { or: [{ legacyId: { equals: story.id } }, { slug: { equals: story.slug } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })

  if (existing.docs[0]) {
    // Source-derived fields only. status and publishedAt are left alone so editorial state
    // (for example a later correction or unpublish) survives a re-run.
    await payload.update({
      collection: 'articles',
      id: existing.docs[0].id,
      data,
      depth: 0,
      overrideAccess: true,
      context: SEED_CONTEXT,
    })
    counts.updated += 1
  } else {
    await payload.create({
      collection: 'articles',
      data: { ...data, status: 'published', publishedAt: new Date(story.dateGMT).toISOString() },
      depth: 0,
      overrideAccess: true,
      context: SEED_CONTEXT,
    })
    counts.created += 1
  }
}

async function main(): Promise<void> {
  const demoEnabled = process.env.SEED_DEMO_USERS === 'true'
  const isProduction = process.env.NODE_ENV === 'production'
  const seedDemo = demoEnabled && !isProduction
  if (demoEnabled && isProduction) {
    console.warn('[seed] SEED_DEMO_USERS is set but NODE_ENV=production; demo data skipped.')
  }

  // Validate inputs before touching the database.
  const stories = await loadStories()
  const demoPassword = seedDemo ? readDemoPassword() : undefined

  const payload = await getPayload({ config })
  const summary = {
    categories: newCounts(),
    articles: newCounts(),
    users: newCounts(),
    liveEvents: newCounts(),
  }

  try {
    const categoryIdBySlug = await upsertCategories(payload, summary.categories)

    const categoryIdByKey = new Map<string, number>()
    for (const cat of CATEGORIES) {
      categoryIdByKey.set(categoryKey(cat.title), categoryIdBySlug.get(cat.slug) as number)
    }

    for (const story of stories) {
      const categoryId = categoryIdByKey.get(categoryKey(story.category))
      if (categoryId === undefined) {
        throw new Error(`Story ${story.slug}: unknown category "${story.category}".`)
      }
      try {
        await upsertArticle(payload, story, categoryId, summary.articles)
      } catch (error) {
        throw new Error(
          `Article seed failed for ${story.slug}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    }

    if (seedDemo && demoPassword !== undefined) {
      await seedDemoUsers(payload, categoryIdBySlug, demoPassword, summary.users)
      await seedDemoLiveEvent(payload, categoryIdBySlug.get('news') as number, summary.liveEvents)
    }

    console.log('[seed] done (images are not imported; see the comment at the top of this file)')
    for (const [name, c] of Object.entries(summary)) {
      console.log(`[seed] ${name.padEnd(11)} created ${c.created}, updated ${c.updated}`)
    }
  } finally {
    await payload.destroy()
  }
}

try {
  await main()
} catch (error) {
  console.error('[seed] failed:', error instanceof Error ? error.message : error)
  if (error instanceof Error && error.stack) console.error(error.stack)
  process.exit(1)
}
