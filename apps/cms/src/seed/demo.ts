import type { Payload } from 'payload'

import type { Role } from '../access/roles'

/**
 * Demo accounts and a demo live event for LOCAL DEVELOPMENT ONLY.
 * Gated in index.ts by SEED_DEMO_USERS=true and NODE_ENV !== 'production'.
 */

export const SEED_CONTEXT = { seed: true } as const

const MIN_PASSWORD_LENGTH = 12
const DEMO_DOMAIN = 'churchtimes.local'
export const DEMO_LIVE_EVENT_SLUG = 'demo-live-event'

type DemoUserSpec = {
  key: string
  name: string
  role: Role
  /** Category slugs (resolved to ids by the caller). */
  sectionSlugs?: string[]
}

const DEMO_USERS: DemoUserSpec[] = [
  { key: 'admin', name: 'Demo Admin', role: 'admin' },
  { key: 'eic', name: 'Demo Editor-in-Chief', role: 'editor-in-chief' },
  {
    key: 'news-editor',
    name: 'Demo News Editor',
    role: 'section-editor',
    sectionSlugs: ['news'],
  },
  {
    key: 'publisher',
    name: 'Demo Trusted Publisher',
    role: 'trusted-publisher',
    sectionSlugs: ['opinion', 'columnists'],
  },
  { key: 'reporter', name: 'Demo Reporter', role: 'reporter' },
]

export type Counts = { created: number; updated: number }

/**
 * Read and validate SEED_DEMO_PASSWORD. Throws before any database write when the password is
 * missing or too short. Never logs the value.
 */
export function readDemoPassword(): string {
  const password = process.env.SEED_DEMO_PASSWORD ?? ''
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `SEED_DEMO_PASSWORD must be set to at least ${MIN_PASSWORD_LENGTH} characters when SEED_DEMO_USERS=true.`,
    )
  }
  return password
}

/**
 * Create or update demo users keyed by email. Existing users keep their password; only name,
 * role and sections are reconciled.
 */
export async function seedDemoUsers(
  payload: Payload,
  categoryIdBySlug: Map<string, number>,
  password: string,
  counts: Counts,
): Promise<void> {
  for (const spec of DEMO_USERS) {
    const email = `${spec.key}@${DEMO_DOMAIN}`
    const sections = (spec.sectionSlugs ?? []).map((slug) => {
      const id = categoryIdBySlug.get(slug)
      if (id === undefined) throw new Error(`Demo user ${email}: unknown category slug "${slug}".`)
      return id
    })

    const existing = await payload.find({
      collection: 'users',
      where: { email: { equals: email } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })

    if (existing.docs[0]) {
      await payload.update({
        collection: 'users',
        id: existing.docs[0].id,
        data: { name: spec.name, role: spec.role, sections },
        depth: 0,
        overrideAccess: true,
        context: SEED_CONTEXT,
      })
      counts.updated += 1
    } else {
      await payload.create({
        collection: 'users',
        data: { email, name: spec.name, role: spec.role, sections, password },
        depth: 0,
        overrideAccess: true,
        context: SEED_CONTEXT,
      })
      counts.created += 1
    }
  }
}

/** One demo live event, always draft so it can never be public. */
export async function seedDemoLiveEvent(
  payload: Payload,
  newsCategoryId: number,
  counts: Counts,
): Promise<void> {
  const data = {
    title: 'Seed demo live event',
    slug: DEMO_LIVE_EVENT_SLUG,
    summary: 'Demo live event created by the seed script. Draft only; never public.',
    status: 'draft' as const,
    category: newsCategoryId,
  }

  const existing = await payload.find({
    collection: 'live-events',
    where: { slug: { equals: DEMO_LIVE_EVENT_SLUG } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })

  if (existing.docs[0]) {
    await payload.update({
      collection: 'live-events',
      id: existing.docs[0].id,
      data,
      depth: 0,
      overrideAccess: true,
      context: SEED_CONTEXT,
    })
    counts.updated += 1
  } else {
    await payload.create({
      collection: 'live-events',
      data,
      depth: 0,
      overrideAccess: true,
      context: SEED_CONTEXT,
    })
    counts.created += 1
  }
}
