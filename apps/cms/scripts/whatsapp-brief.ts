/**
 * `npm run whatsapp:brief -- [--date YYYY-MM-DD] [--out dir] [--limit 5] [--cms-url URL]`
 *
 * Writes `whatsapp-brief-<date>.txt` (ready to paste into WhatsApp) and `whatsapp-brief-<date>.png` (1080x1080 card) for
 * one Africa/Lagos day. Deterministic: the published stories of that day, newest first; no AI and no third-party API.
 * Reads only the CMS's anonymous public article list (`GET /api/articles`, published only), so it needs no database
 * access or credentials. Default output folder: apps/cms/private-reports/whatsapp/ (git-ignored).
 *
 * Environment: CMS_PUBLIC_URL (or --cms-url), PUBLIC_SITE_URL (article links; omitted when unset),
 * PUBLIC_ARTICLE_PATH_TEMPLATE (default /{slug}/), WHATSAPP_GROUP_URL (optional override of the link in src/lib/social-links.js).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { renderBriefCard } from '../src/lib/shareCard'
import {
  buildBriefText,
  fetchBriefArticles,
  parseBriefArgs,
  resolveBriefConfig,
  selectBriefStories,
} from '../src/lib/whatsappBrief'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The group invite from the site's single source of social links; WHATSAPP_GROUP_URL wins when set. Https only. */
async function whatsappUrl(): Promise<string | null> {
  const https = (v: unknown): string | null => {
    try {
      const u = new URL(String(v))
      return u.protocol === 'https:' && !u.username && !u.password ? u.href : null
    } catch {
      return null
    }
  }
  if (process.env.WHATSAPP_GROUP_URL?.trim()) return https(process.env.WHATSAPP_GROUP_URL.trim())
  try {
    const mod = (await import(pathToFileURL(path.resolve(here, '../../../src/lib/social-links.js')).href)) as {
      SOCIAL_LINKS?: Array<{ id: string; url: string }>
    }
    return https(mod.SOCIAL_LINKS?.find((l) => l.id === 'whatsapp')?.url)
  } catch {
    return null // run outside the repository checkout: no group link line
  }
}

async function main(): Promise<void> {
  const args = parseBriefArgs(process.argv.slice(2), new Date(), process.env, path.resolve(here, '../private-reports/whatsapp'))
  if (!args.cmsUrl) throw new Error('Set CMS_PUBLIC_URL or pass --cms-url (https, or http on localhost).')
  const config = resolveBriefConfig(process.env)
  const articles = await fetchBriefArticles(args.cmsUrl, args.date)
  const selection = selectBriefStories(articles, args.date, args.limit)
  const text = buildBriefText({ date: args.date, selection, siteUrl: config.siteUrl, template: config.template, whatsappUrl: await whatsappUrl() })
  const card = await renderBriefCard({
    date: args.date,
    headlines: selection.stories.map((s) => s.title),
    footer: config.siteUrl ? new URL(config.siteUrl).host : '',
  })
  await mkdir(args.out, { recursive: true })
  const base = path.join(args.out, `whatsapp-brief-${args.date}`)
  await writeFile(`${base}.txt`, text, 'utf8')
  await writeFile(`${base}.png`, card)
  console.log(
    `WhatsApp brief for ${args.date}: ${selection.stories.length} stories${selection.fallback ? ' (fallback: latest stories)' : ''}.\n${base}.txt\n${base}.png`,
  )
  if (!config.siteUrl) console.log('PUBLIC_SITE_URL is not set: the text has no article links.')
}

main().catch((err: unknown) => {
  console.error(`whatsapp:brief failed: ${err instanceof Error ? err.message : 'unknown error'}`)
  process.exit(1)
})
