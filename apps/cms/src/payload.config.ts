import path from 'path'
import { fileURLToPath } from 'url'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import sharp from 'sharp'

import { Articles } from './collections/Articles'
import { AuditLogs } from './collections/AuditLogs'
import { Categories } from './collections/Categories'
import { LiveEvents } from './collections/LiveEvents'
import { LiveUpdates } from './collections/LiveUpdates'
import { Media } from './collections/Media'
import { Submissions } from './collections/Submissions'
import { Users } from './collections/Users'
import { previewArticleEndpoint } from './endpoints/previewArticle'
import { publicSubmissionsEndpoint } from './endpoints/publicSubmissions'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const secret = process.env.PAYLOAD_SECRET
if (process.env.NODE_ENV !== 'test' && (!secret || secret.length < 32)) {
  throw new Error('PAYLOAD_SECRET must be set and at least 32 characters long.')
}

const corsOrigins = csv(process.env.CMS_CORS_ORIGINS)
const csrfOrigins = csv(process.env.CMS_CSRF_ORIGINS)

export default buildConfig({
  secret: secret || 'test-only-secret-not-for-production-use-0123456789',
  serverURL: process.env.CMS_PUBLIC_URL || undefined,
  cors: corsOrigins,
  csrf: csrfOrigins,
  admin: {
    user: 'users',
    importMap: { baseDir: path.resolve(dirname) },
  },
  collections: [Users, Categories, Media, Articles, Submissions, LiveEvents, LiveUpdates, AuditLogs],
  endpoints: [publicSubmissionsEndpoint, previewArticleEndpoint],
  editor: lexicalEditor(),
  db: postgresAdapter({
    pool: { connectionString: process.env.DATABASE_URL },
    migrationDir: path.resolve(dirname, 'migrations'),
    push: process.env.NODE_ENV !== 'production' && process.env.PAYLOAD_DB_PUSH === 'true',
  }),
  sharp,
  upload: { limits: { fileSize: 10 * 1024 * 1024 } },
  graphQL: { disable: true },
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
})
