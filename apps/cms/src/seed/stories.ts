import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** One entry of the legacy Church Times Nigeria export (`src/data/stories.json`). */
export type Story = {
  id: number
  slug: string
  title: string
  date: string
  dateGMT: string
  source: string
  author: string
  category: string
  categories?: string[]
  image?: string
  imageSource?: string
  imageAlt?: string
  originalReadMinutes?: number
  summary?: string
  briefing: string[]
}

const here = path.dirname(fileURLToPath(import.meta.url))

/** apps/cms/src/seed -> churchtimes-payload-core/src/data/stories.json */
export const DEFAULT_STORIES_PATH = path.resolve(here, '../../../../src/data/stories.json')

const isStory = (v: unknown): v is Story => {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return (
    typeof s.id === 'number' &&
    typeof s.slug === 'string' &&
    typeof s.title === 'string' &&
    typeof s.dateGMT === 'string' &&
    typeof s.source === 'string' &&
    typeof s.author === 'string' &&
    typeof s.category === 'string' &&
    (s.summary === undefined || typeof s.summary === 'string') &&
    Array.isArray(s.briefing) &&
    s.briefing.every((p) => typeof p === 'string')
  )
}

/**
 * Read the legacy stories export. READ ONLY. Path comes from SEED_STORIES_PATH when set,
 * otherwise DEFAULT_STORIES_PATH.
 */
export async function loadStories(): Promise<Story[]> {
  const override = process.env.SEED_STORIES_PATH?.trim()
  const file = override ? path.resolve(override) : DEFAULT_STORIES_PATH
  const raw = (await readFile(file, 'utf8')).replace(/^﻿/, '')
  const parsed = JSON.parse(raw) as { stories?: unknown }

  if (!Array.isArray(parsed.stories)) {
    throw new Error(`${file}: expected a top-level "stories" array.`)
  }
  parsed.stories.forEach((item, i) => {
    if (!isStory(item)) {
      throw new Error(`${file}: stories[${i}] does not match the expected story shape.`)
    }
  })
  return parsed.stories as Story[]
}
