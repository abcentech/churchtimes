import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

/**
 * Share cards (Open Graph images and the WhatsApp brief card) rendered on the CPU with sharp, which the CMS already
 * depends on for media resizing. No new dependency, no network call, no AI: the same input always gives the same PNG.
 *
 * Text is set by sharp's text input (libvips + Pango) with the bundled Newsreader TTF (SIL OFL 1.1, see
 * src/assets/fonts/OFL-Newsreader.txt). The background is an SVG with shapes only, so no system font is ever needed.
 * Every string is plain text: it is escaped before it becomes Pango markup, so CMS text can never inject markup.
 */

export const FONT_FILE_NAME = 'Newsreader-opsz-wght.ttf'
const FONT_FAMILY = 'Newsreader'

export const BRAND = {
  ink: '#172b2e',
  inkDeep: '#0f1f21',
  gold: '#c39368',
  paper: '#f7f5ef',
  white: '#fffefa',
  muted: '#b9c2bf',
} as const

export const OG_WIDTH = 1200
export const OG_HEIGHT = 630
export const BRIEF_SIZE = 1080

let fontFileCache: string | undefined

/**
 * The bundled font. Looked up in SHARE_CARD_FONT_DIR, then `<cwd>/src/assets/fonts` (the Docker runtime image copies
 * src/ to /app/src and runs from /app; `npm run dev` runs from apps/cms), then next to this module (tsx scripts, tests).
 */
export function resolveFontFile(env: NodeJS.ProcessEnv = process.env): string {
  if (fontFileCache) return fontFileCache
  const candidates: string[] = []
  const configured = env.SHARE_CARD_FONT_DIR?.trim()
  if (configured) candidates.push(resolve(configured, FONT_FILE_NAME))
  candidates.push(resolve(process.cwd(), 'src/assets/fonts', FONT_FILE_NAME))
  try {
    candidates.push(resolve(dirname(fileURLToPath(import.meta.url)), '../assets/fonts', FONT_FILE_NAME))
  } catch {
    // Bundled code may not have a file: URL for this module; the cwd candidate covers the server.
  }
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('Share card font not found (src/assets/fonts).')
  fontFileCache = found
  return found
}

// ---- Text helpers (pure) ----

/** Pango markup escape. Also drops control characters (except none: newlines are folded to spaces by `cleanCardText`). */
export function escapeMarkup(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** One line of plain text: control characters and runs of whitespace become single spaces, trimmed, NFC. */
export function cleanCardText(value: unknown, max = 400): string {
  if (typeof value !== 'string') return ''
  return value
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Shortens at a word boundary and adds an ellipsis when `text` is longer than `max` characters. */
export function clampText(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  const cut = chars.slice(0, Math.max(1, max - 1)).join('')
  const space = cut.lastIndexOf(' ')
  const base = space > max * 0.6 ? cut.slice(0, space) : cut
  return `${base.replace(/[\s,;:.\-–—]+$/u, '')}…`
}

/** "30 October 2026" in Africa/Lagos. Empty for a missing or invalid date. */
export function formatLagosDate(value: unknown): string {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'long', year: 'numeric' }).format(d)
}

// ---- Rendering ----

type TextLayer = { input: Buffer; top: number; left: number; width: number; height: number }

type TextOptions = {
  text: string
  size: number
  weight?: number
  color: string
  width: number
  /** Maximum height: a taller render is redone with autofit (smaller type) inside this box. */
  maxHeight?: number
  spacing?: number
  letterSpacing?: number
  align?: 'left' | 'centre' | 'right'
}

/** Renders one block of escaped plain text to an RGBA buffer. */
async function textLayer(opts: TextOptions): Promise<{ input: Buffer; width: number; height: number }> {
  const span = `<span foreground="${opts.color}" font_weight="${opts.weight ?? 400}"${
    opts.letterSpacing ? ` letter_spacing="${Math.round(opts.letterSpacing * 1024)}"` : ''
  }>${escapeMarkup(opts.text)}</span>`
  const base = {
    text: span,
    font: `${FONT_FAMILY} ${opts.size}`,
    fontfile: resolveFontFile(),
    width: opts.width,
    rgba: true,
    wrap: 'word' as const,
    align: opts.align ?? 'left',
    ...(opts.spacing ? { spacing: opts.spacing } : {}),
  }
  let out = await sharp({ text: { ...base, dpi: 72 } }).png().toBuffer({ resolveWithObject: true })
  if (opts.maxHeight && out.info.height > opts.maxHeight) {
    // Too tall even after clamping the characters: let libvips pick the size that fits the box.
    out = await sharp({ text: { ...base, height: opts.maxHeight } }).png().toBuffer({ resolveWithObject: true })
  }
  return { input: out.data, width: out.info.width, height: out.info.height }
}

const svgBuffer = (svg: string): Buffer => Buffer.from(svg)

async function compose(width: number, height: number, background: string, layers: TextLayer[]): Promise<Buffer> {
  return sharp(svgBuffer(background))
    .resize(width, height)
    .composite(layers.map((l) => ({ input: l.input, top: Math.round(l.top), left: Math.round(l.left) })))
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer()
}

export type ShareCardInput = {
  title: string
  /** Category or kicker shown above the headline (plain text). */
  label?: string | null
  /** Publication date; shown in Africa/Lagos. */
  date?: string | Date | null
}

export const HEADLINE_MAX_CHARS = 120

/** 1200x630 Open Graph card. Throws only when the font is missing or sharp fails. */
export async function renderShareCard(input: ShareCardInput): Promise<Buffer> {
  const W = OG_WIDTH
  const H = OG_HEIGHT
  const padX = 80
  const title = clampText(cleanCardText(input.title, 400) || 'Church Times Nigeria', HEADLINE_MAX_CHARS)
  const label = clampText(cleanCardText(input.label, 80), 40).toUpperCase()
  const date = formatLagosDate(input.date)

  const background = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${BRAND.ink}"/>
<rect x="0" y="0" width="16" height="${H}" fill="${BRAND.gold}"/>
<rect x="${padX}" y="${H - 132}" width="${W - padX * 2}" height="2" fill="${BRAND.gold}" opacity="0.55"/>
<circle cx="${W - 70}" cy="70" r="150" fill="${BRAND.inkDeep}" opacity="0.6"/>
</svg>`

  const layers: TextLayer[] = []
  let y = 72
  if (label) {
    const l = await textLayer({ text: label, size: 26, weight: 700, color: BRAND.gold, width: W - padX * 2, letterSpacing: 2 })
    layers.push({ ...l, top: y, left: padX })
    y += l.height + 24
  }
  const headlineBox = H - 132 - 36 - y
  const headline = await textLayer({
    text: title,
    size: 62,
    weight: 600,
    color: BRAND.white,
    width: W - padX * 2,
    maxHeight: headlineBox,
    spacing: 8,
  })
  layers.push({ ...headline, top: y, left: padX })

  const mark = await textLayer({ text: 'Church Times Nigeria', size: 34, weight: 700, color: BRAND.paper, width: 600 })
  layers.push({ ...mark, top: H - 132 + 34, left: padX })
  if (date) {
    const d = await textLayer({ text: date, size: 26, weight: 400, color: BRAND.muted, width: 420, align: 'right' })
    layers.push({ ...d, top: H - 132 + 40, left: W - padX - d.width })
  }
  return compose(W, H, background, layers)
}

export type BriefCardInput = {
  /** Lagos calendar date, `YYYY-MM-DD`. */
  date: string
  headlines: string[]
  /** Optional line under the list, e.g. where to read more (plain text). */
  footer?: string
}

/** 1080x1080 card for the WhatsApp daily brief: date, up to five numbered headlines, wordmark. */
export async function renderBriefCard(input: BriefCardInput): Promise<Buffer> {
  const S = BRIEF_SIZE
  const padX = 84
  const items = input.headlines.map((h) => clampText(cleanCardText(h, 300), 96)).filter(Boolean).slice(0, 5)
  const dateLabel = formatLagosDate(`${input.date}T12:00:00+01:00`) || input.date

  const background = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
<rect width="${S}" height="${S}" fill="${BRAND.ink}"/>
<rect x="0" y="0" width="${S}" height="16" fill="${BRAND.gold}"/>
<rect x="${padX}" y="${S - 150}" width="${S - padX * 2}" height="2" fill="${BRAND.gold}" opacity="0.55"/>
</svg>`

  const layers: TextLayer[] = []
  const kicker = await textLayer({ text: 'DAILY BRIEF', size: 28, weight: 700, color: BRAND.gold, width: 600, letterSpacing: 3 })
  layers.push({ ...kicker, top: 78, left: padX })
  const when = await textLayer({ text: dateLabel, size: 48, weight: 600, color: BRAND.white, width: S - padX * 2 })
  layers.push({ ...when, top: 78 + kicker.height + 14, left: padX })

  let y = 78 + kicker.height + 14 + when.height + 46
  const listBottom = S - 150 - 30
  const perItem = items.length ? Math.floor((listBottom - y) / items.length) : 0
  for (const [i, text] of items.entries()) {
    const num = await textLayer({ text: String(i + 1), size: 40, weight: 700, color: BRAND.gold, width: 60 })
    const line = await textLayer({
      text,
      size: 36,
      weight: 500,
      color: BRAND.paper,
      width: S - padX * 2 - 70,
      maxHeight: Math.max(40, perItem - 22),
      spacing: 4,
    })
    layers.push({ ...num, top: y, left: padX })
    layers.push({ ...line, top: y + 2, left: padX + 70 })
    y += Math.min(perItem, line.height + 30)
  }
  const mark = await textLayer({ text: 'Church Times Nigeria', size: 38, weight: 700, color: BRAND.paper, width: 600 })
  layers.push({ ...mark, top: S - 150 + 34, left: padX })
  const footer = clampText(cleanCardText(input.footer, 120), 60)
  if (footer) {
    const f = await textLayer({ text: footer, size: 24, weight: 400, color: BRAND.muted, width: 380, align: 'right' })
    layers.push({ ...f, top: S - 150 + 44, left: S - padX - f.width })
  }
  return compose(S, S, background, layers)
}
