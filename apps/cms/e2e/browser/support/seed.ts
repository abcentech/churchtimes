/**
 * Synthetic data for the browser auth E2E run. Executed with `payload run` against the throw-away
 * database the Playwright globalSetup booted (never against a real environment).
 *
 * Writes `{ credentials, articles }` to the file named by CT_SEED_OUT (a temp file outside the
 * repository). Passwords are random per run and are never logged.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'

import config from '@payload-config'
import { getPayload } from 'payload'

import { textToLexical } from '../../../src/endpoints/convertSubmission'

const out = process.env.CT_SEED_OUT
if (!out) throw new Error('CT_SEED_OUT is required')

const randomPassword = (): string => `${randomBytes(15).toString('base64url')}-aZ9!`

async function main() {
  const payload = await getPayload({ config })
  const seedCtx = { seed: true }

  const cat = await payload.create({
    collection: 'categories',
    data: { title: 'E2E News', slug: 'e2e-news' },
    overrideAccess: true,
  })

  const specs = [
    { key: 'admin', role: 'admin', sections: [] as number[] },
    { key: 'editor-in-chief', role: 'editor-in-chief', sections: [] },
    { key: 'section-editor', role: 'section-editor', sections: [cat.id as number] },
    { key: 'reporter', role: 'reporter', sections: [] },
  ]
  const credentials: Record<string, { email: string; password: string; id: number }> = {}
  for (const s of specs) {
    const email = `e2e-${s.key}@churchtimes.invalid`
    const password = randomPassword()
    const u = await payload.create({
      collection: 'users',
      data: { email, name: `E2E ${s.key}`, password, role: s.role, sections: s.sections } as never,
      overrideAccess: true,
      context: seedCtx,
    })
    credentials[s.key] = { email, password, id: u.id as number }
  }

  const mk = async (slug: string, title: string, status: string, author?: number) => {
    const doc = await payload.create({
      collection: 'articles',
      data: {
        title,
        slug,
        content: textToLexical(`Synthetic body for ${title}.`),
        category: cat.id,
        status,
        ...(author ? { author } : {}),
        ...(status === 'published' ? { publishedAt: new Date().toISOString() } : {}),
      } as never,
      overrideAccess: true,
      context: seedCtx,
    })
    return { id: doc.id as number, slug, title, status }
  }
  const articles = {
    published1: await mk('e2e-published-one', 'E2E Published One', 'published'),
    published2: await mk('e2e-published-two', 'E2E Published Two', 'published'),
    draft: await mk('e2e-secret-draft', 'E2E Secret Draft Zed', 'draft', credentials.reporter.id),
  }

  fs.writeFileSync(out as string, JSON.stringify({ credentials, articles, categoryId: cat.id }), { mode: 0o600 })
  console.log('[e2e-seed] seeded roles:', Object.keys(credentials).join(', '), 'articles:', Object.keys(articles).join(', '))
  await payload.destroy()
  process.exit(0)
}

try {
  await main()
} catch (err) {
  console.error('[e2e-seed] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
}
