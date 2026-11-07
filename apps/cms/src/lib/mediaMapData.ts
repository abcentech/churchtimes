import type { Payload } from 'payload'

import type { MediaDocLike } from './mediaMapExport'

/**
 * Database side of the media map. Two reads, so privacy comes from the SAME rule the public media file route uses:
 * 1. Ids readable by an ANONYMOUS caller (`overrideAccess: false`, no user): `Media.readAccess` decides (media of a
 *    published article, an approved live update of a live/ended event, or a delivered ad creative). Drafts,
 *    in-review, scheduled, archived/withdrawn and unreferenced media are not returned.
 * 2. A trusted read of the staff-only `legacyPath` and file facts for media that have a legacy path. Only documents
 *    whose id is in step 1 are exported (`buildMediaMap`).
 */

const PAGE = 500

async function pages<T>(fetchPage: (page: number) => Promise<{ docs: T[]; hasNextPage: boolean }>): Promise<T[]> {
  const out: T[] = []
  for (let page = 1; page < 10_000; page++) {
    const res = await fetchPage(page)
    out.push(...res.docs)
    if (!res.hasNextPage) break
  }
  return out
}

export async function loadAnonymousMediaIds(payload: Payload): Promise<Set<string | number>> {
  const docs = await pages((page) =>
    payload.find({
      collection: 'media',
      overrideAccess: false,
      user: null,
      depth: 0,
      limit: PAGE,
      page,
      sort: 'id',
      select: { id: true },
    } as never),
  )
  return new Set((docs as Array<{ id: string | number }>).map((d) => d.id))
}

export async function loadMediaWithLegacyPath(payload: Payload): Promise<MediaDocLike[]> {
  const docs = await pages((page) =>
    payload.find({
      collection: 'media',
      overrideAccess: true,
      depth: 0,
      limit: PAGE,
      page,
      sort: 'id',
      where: { legacyPath: { exists: true } },
      select: { legacyPath: true, filename: true, mimeType: true, filesize: true },
    } as never),
  )
  return docs as MediaDocLike[]
}
