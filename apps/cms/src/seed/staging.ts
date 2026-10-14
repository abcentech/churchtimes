/**
 * Synthetic staging fixtures: `payload run src/seed/staging.ts` (driven by scripts/staging-up.mjs).
 *
 * EVERYTHING here is invented test data. It does NOT contain the real legacy stories (see src/seed/index.ts
 * for those) and must never be run against a production database. It refuses to run unless
 * CMS_ALLOW_INSECURE_LOCAL_STAGING=true with loopback-only origins (the rule the CMS itself applies) and a loopback
 * DATABASE_URL.
 *
 * Env:
 *   DATABASE_URL, PAYLOAD_SECRET   as for the app
 *   STAGING_CREDENTIALS_FILE       JSON written by staging-up.mjs: { users: { <key>: { email, password, role } } }
 *                                  Passwords are read from this file only; they are never logged.
 *
 * Idempotent: records are upserted by slug / email. The password of an EXISTING synthetic user (exact email from the credentials
 * file) is reset to the file's value so the file and the database cannot drift apart.
 *
 * Seeded:
 *   - the 9 site categories (taxonomy only)
 *   - synthetic staff, one per role (admin, editor-in-chief, section-editor [news], trusted-publisher [news], reporter)
 *   - synthetic articles in every status (published x6, draft, in_review, changes_requested, approved,
 *     scheduled, archived), slugs prefixed `staging-`
 *   - one LIVE event with approved + pending updates, one DRAFT event (must stay hidden from anonymous users)
 *   - one `new` submission
 */
import fs from 'node:fs'

import config from '@payload-config'
import { getPayload, type Payload } from 'payload'

import { insecureLocalStaging, isLoopbackHostname } from '../lib/securityConfig'
import { paragraphsToLexical } from './lexical'

const SEED = { seed: true } as const

const CATEGORIES = [
  ['News', 'news'],
  ['Features', 'features'],
  ['Opinion', 'opinion'],
  ['Columnists', 'columnists'],
  ['Interviews', 'interviews'],
  ['Business', 'business'],
  ['Education', 'education'],
  ['Health', 'health'],
  ["Publisher's Note", 'publishers-note'],
] as const

type Creds = { users: Record<string, { email: string; password: string; role: string }> }

const readCredentials = (): Creds => {
  const file = process.env.STAGING_CREDENTIALS_FILE
  if (!file) throw new Error('STAGING_CREDENTIALS_FILE is not set (run through `npm run staging:up`).')
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Creds
  for (const key of ['admin', 'editor-in-chief', 'section-editor', 'trusted-publisher', 'reporter']) {
    const u = parsed.users?.[key]
    if (!u?.email || !u.password || u.password.length < 12) {
      throw new Error(`Credentials file is missing a valid "${key}" entry.`)
    }
  }
  // The seed creates these accounts and resets their passwords, so it may only ever touch synthetic addresses.
  for (const [key, u] of Object.entries(parsed.users ?? {})) {
    if (!/^[a-z0-9._-]+@staging\.invalid$/i.test(u?.email ?? '')) {
      throw new Error(`Credentials file entry "${key}" is not a synthetic @staging.invalid address; refusing to seed.`)
    }
  }
  return parsed
}

type Collection = 'categories' | 'users' | 'articles' | 'live-events'

async function upsert(
  payload: Payload,
  collection: Collection,
  where: Record<string, unknown>,
  data: Record<string, unknown>,
): Promise<{ id: number }> {
  const existing = await payload.find({ collection, where: where as never, limit: 1, depth: 0, overrideAccess: true })
  if (existing.docs[0]) {
    return (await payload.update({
      collection,
      id: existing.docs[0].id,
      data: data as never,
      depth: 0,
      overrideAccess: true,
      context: SEED,
    })) as unknown as { id: number }
  }
  return (await payload.create({
    collection,
    data: data as never,
    depth: 0,
    overrideAccess: true,
    context: SEED,
  })) as unknown as { id: number }
}

async function main(): Promise<void> {
  if (process.env.CMS_ALLOW_INSECURE_LOCAL_STAGING !== 'true') {
    throw new Error('Refusing to seed synthetic staging data: CMS_ALLOW_INSECURE_LOCAL_STAGING is not "true".')
  }
  // Same loopback-only rule the CMS applies (checked here too: `payload run` without NODE_ENV=production skips
  // validateProductionEnv), and never write to a database that is not on this machine.
  const staging = insecureLocalStaging(process.env)
  if (!staging.enabled) throw new Error(`Refusing to seed synthetic staging data: ${staging.problems.join(' ')}`)
  let dbHost = ''
  try {
    const dbUrl = new URL(process.env.DATABASE_URL ?? '')
    // pg honours ?host= / ?hostaddr= over the URL's host, which would get around the loopback check.
    if (!dbUrl.searchParams.has('host') && !dbUrl.searchParams.has('hostaddr')) dbHost = dbUrl.hostname
  } catch {
    // not a URL: refused below
  }
  if (!isLoopbackHostname(dbHost)) {
    throw new Error('Refusing to seed synthetic staging data: DATABASE_URL must point at 127.0.0.1 / localhost.')
  }
  const creds = readCredentials()
  const payload = await getPayload({ config })

  try {
    const cat: Record<string, number> = {}
    for (const [title, slug] of CATEGORIES) {
      cat[slug] = (await upsert(payload, 'categories', { slug: { equals: slug } }, { title, slug })).id
    }

    const roleSections: Record<string, number[]> = {
      'section-editor': [cat.news!],
      'trusted-publisher': [cat.news!],
    }
    const userId: Record<string, number> = {}
    for (const [key, u] of Object.entries(creds.users)) {
      const row = await payload.find({
        collection: 'users',
        where: { email: { equals: u.email } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
      })
      if (row.docs[0]) {
        // Keep the credentials file and the database in step (staging:funnel regenerates the file if it was lost). Only these exact
        // synthetic accounts (the emails listed in the credentials file) are touched.
        await payload.update({
          collection: 'users',
          id: row.docs[0].id,
          data: { password: u.password } as never,
          depth: 0,
          overrideAccess: true,
          context: SEED,
        })
        userId[key] = row.docs[0].id
        continue
      }
      const created = await payload.create({
        collection: 'users',
        data: {
          email: u.email,
          name: `Staging ${key}`,
          role: u.role,
          sections: roleSections[u.role] ?? [],
          password: u.password,
        } as never,
        depth: 0,
        overrideAccess: true,
        context: SEED,
      })
      userId[key] = created.id
    }

    const day = 24 * 3600 * 1000
    const now = Date.now()
    const body = (title: string) =>
      paragraphsToLexical([
        `${title}. This is synthetic staging content created for end-to-end testing; it is not a real news story.`,
        'Second paragraph of synthetic text so that the article renders more than one block.',
      ])
    const ago = (days: number) => new Date(now - days * day).toISOString()

    const articles: { slug: string; title: string; category: string; status: string; extra?: Record<string, unknown> }[] = [
      { slug: 'staging-published-1', title: 'Synthetic story one: parish hall reopens', category: 'news', status: 'published', extra: { publishedAt: ago(1), excerpt: 'Synthetic excerpt one.', bylineName: 'Staging Reporter' } },
      { slug: 'staging-published-2', title: 'Synthetic story two: choir tour announced', category: 'news', status: 'published', extra: { publishedAt: ago(2), excerpt: 'Synthetic excerpt two.' } },
      { slug: 'staging-published-3', title: 'Synthetic feature three: a year of outreach', category: 'features', status: 'published', extra: { publishedAt: ago(3) } },
      { slug: 'staging-published-4', title: 'Synthetic opinion four: on listening', category: 'opinion', status: 'published', extra: { publishedAt: ago(4) } },
      { slug: 'staging-published-5', title: 'Synthetic business five: cooperative savings', category: 'business', status: 'published', extra: { publishedAt: ago(5) } },
      { slug: 'staging-published-6', title: 'Synthetic health six: clinic open day', category: 'health', status: 'published', extra: { publishedAt: ago(6), corrections: [{ note: 'Synthetic correction: a date was fixed.' }] } },
      { slug: 'staging-draft-1', title: 'Synthetic draft: never public', category: 'news', status: 'draft' },
      { slug: 'staging-in-review-1', title: 'Synthetic story awaiting review', category: 'news', status: 'in_review' },
      { slug: 'staging-changes-requested-1', title: 'Synthetic story needing changes', category: 'features', status: 'changes_requested', extra: { reviewNotes: 'Synthetic editor note.' } },
      { slug: 'staging-approved-1', title: 'Synthetic approved story ready to publish', category: 'news', status: 'approved' },
      { slug: 'staging-scheduled-1', title: 'Synthetic scheduled story', category: 'news', status: 'scheduled', extra: { scheduledFor: new Date(now + 30 * day).toISOString() } },
      { slug: 'staging-archived-1', title: 'Synthetic archived story', category: 'news', status: 'archived', extra: { publishedAt: ago(60) } },
    ]
    for (const a of articles) {
      await upsert(
        payload,
        'articles',
        { slug: { equals: a.slug } },
        {
          title: a.title,
          slug: a.slug,
          content: body(a.title),
          category: cat[a.category],
          status: a.status,
          author: userId.reporter,
          ...(a.extra ?? {}),
        },
      )
    }

    // Live coverage: one live event (approved + pending updates) and one draft event.
    const live = await upsert(
      payload,
      'live-events',
      { slug: { equals: 'staging-live-event' } },
      {
        title: 'Synthetic live event',
        slug: 'staging-live-event',
        summary: 'Synthetic live coverage for staging tests.',
        status: 'live',
        category: cat.news,
        startedAt: new Date(now - 3600_000).toISOString(),
      },
    )
    await upsert(
      payload,
      'live-events',
      { slug: { equals: 'staging-draft-event' } },
      {
        title: 'Synthetic draft event',
        slug: 'staging-draft-event',
        summary: 'Draft: hidden from anonymous readers.',
        status: 'draft',
        category: cat.news,
      },
    )

    const existingUpdates = await payload.find({
      collection: 'live-updates',
      where: { event: { equals: live.id } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    if (existingUpdates.totalDocs === 0) {
      const updates = [
        ['Synthetic approved update one.', 'approved'],
        ['Synthetic approved update two.', 'approved'],
        ['Synthetic PENDING update: not public until approved.', 'pending'],
      ] as const
      let i = 0
      for (const [text, status] of updates) {
        await payload.create({
          collection: 'live-updates',
          data: {
            event: live.id,
            body: text,
            status,
            author: userId.reporter,
            occurredAt: new Date(now - (3 - i++) * 600_000).toISOString(),
            ...(status === 'approved'
              ? { approvedBy: userId['editor-in-chief'], approvedAt: new Date().toISOString() }
              : {}),
          } as never,
          depth: 0,
          overrideAccess: true,
          context: SEED,
        })
      }
    }

    const sub = await payload.find({
      collection: 'submissions',
      where: { reference: { equals: 'SUB-STAGING1' } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    if (!sub.docs[0]) {
      await payload.create({
        collection: 'submissions',
        data: {
          reference: 'SUB-STAGING1',
          name: 'Synthetic Contributor',
          email: 'synthetic-contributor@staging.invalid',
          title: 'Synthetic community tip',
          body: 'This is a synthetic submission body created for staging tests; it is long enough to pass validation.',
          status: 'new',
        } as never,
        depth: 0,
        overrideAccess: true,
        context: SEED,
      })
    }

    console.log(
      `[seed:staging] done: ${CATEGORIES.length} categories, ${Object.keys(creds.users).length} users, ` +
        `${articles.length} articles, 2 live events, 1 submission`,
    )
  } finally {
    await payload.destroy()
  }
}

try {
  await main()
  process.exit(0)
} catch (error) {
  console.error('[seed:staging] failed:', error instanceof Error ? error.message : error)
  if (error instanceof Error && error.stack) console.error(error.stack)
  process.exit(1)
}
