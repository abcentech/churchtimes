import config from '@payload-config'
import path from 'node:path'
import { getPayload } from 'payload'

import { checkDirectoryWritable, readinessResponse, type ReadinessProbes } from '../../../../../lib/health'
import { getClientIp } from '../../../../../lib/rateLimit'
import { migrations } from '../../../../../migrations'

export const dynamic = 'force-dynamic'

type Pool = { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> }

async function getProbes(): Promise<ReadinessProbes> {
  const payload = await getPayload({ config })
  const pool = (payload.db as unknown as { pool: Pool }).pool
  const upload = payload.collections.media.config.upload
  const mediaDir = path.resolve(typeof upload === 'object' && upload.staticDir ? upload.staticDir : 'media')
  return {
    pingDatabase: async () => {
      await pool.query('select 1')
    },
    appliedMigrations: async () => (await pool.query('select name from payload_migrations')).rows.map((r) => String(r.name)),
    bundledMigrations: migrations.map((m) => m.name),
    checkMediaWritable: () => checkDirectoryWritable(mediaDir),
  }
}

const handle = (req: Request) => readinessResponse(req.method, getClientIp(req), getProbes)

export const GET = handle
export const HEAD = handle
