import path from 'path'
import { fileURLToPath } from 'url'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { nodemailerAdapter } from '@payloadcms/email-nodemailer'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import sharp from 'sharp'

import { Articles } from './collections/Articles'
import { AuditLogs } from './collections/AuditLogs'
import { AdCampaigns } from './collections/AdCampaigns'
import { Advertisers } from './collections/Advertisers'
import { Categories } from './collections/Categories'
import { ContactMessages } from './collections/ContactMessages'
import { LiveEvents } from './collections/LiveEvents'
import { LiveUpdates } from './collections/LiveUpdates'
import { Media } from './collections/Media'
import { LegacyComments } from './collections/LegacyComments'
import { Redirects } from './collections/Redirects'
import { Submissions } from './collections/Submissions'
import { Subscribers } from './collections/Subscribers'
import { Users } from './collections/Users'
import { w12Collections, w12Endpoints, w12Globals } from './w12'
import { previewArticleEndpoint } from './endpoints/previewArticle'
import { publicSearchEndpoints } from './endpoints/publicSearch'
import { staffRelatedArticlesEndpoints } from './endpoints/staffRelatedArticles'
import { startupSelfCheck } from './lib/health'
import { publicContactEndpoint, publicContactPreflightEndpoint } from './endpoints/publicContact'
import { newsletterEndpoints } from './endpoints/publicNewsletter'
import { givingEndpoints } from './endpoints/publicGiving'
import {
  publicAdvertisingEndpoint,
  publicAdvertisingHeadEndpoint,
  publicAdvertisingPreflightEndpoint,
} from './endpoints/publicAdvertising'
import {
  publicRedirectsEndpoint,
  publicRedirectsHeadEndpoint,
  publicRedirectsPreflightEndpoint,
} from './endpoints/publicRedirects'
import {
  publicSubmissionsEndpoint,
  publicSubmissionsPreflightEndpoint,
} from './endpoints/publicSubmissions'
import { avMaxBytes } from './lib/avMedia'
import { parseAllowedHosts, parseLegacyHosts, resolveArticlePathTemplate } from './lib/redirectPaths'
import { startScheduler } from './lib/scheduler'
import {
  checkOriginList,
  csv,
  normaliseOrigin,
  turnstileActionWarnings,
  validateProductionEnv,
} from './lib/securityConfig'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

const isProd = process.env.NODE_ENV === 'production'
const isTest = process.env.NODE_ENV === 'test'
// `next build` also runs with NODE_ENV=production but without the runtime secrets; the strict
// checks run when the server actually starts (phase-production-server).
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build'

const secret = process.env.PAYLOAD_SECRET
if (!isTest && (!secret || secret.length < 32)) {
  throw new Error('PAYLOAD_SECRET must be set and at least 32 characters long.')
}

// Redirect settings (go-live C7) fail loudly at startup: a typo in PUBLIC_ARTICLE_PATH_TEMPLATE would otherwise turn
// into wrong redirects. Unset values are fine (default template, no absolute redirect hosts).
resolveArticlePathTemplate(process.env)
parseAllowedHosts(process.env)
parseLegacyHosts(process.env)

const corsOrigins = csv(process.env.CMS_CORS_ORIGINS).map(normaliseOrigin)
const csrfOrigins = csv(process.env.CMS_CSRF_ORIGINS).map(normaliseOrigin)

if (isProd && !isBuildPhase) {
  const { problems, warnings } = validateProductionEnv(process.env)
  if (problems.length > 0) {
    throw new Error(`Insecure or incomplete production configuration: ${problems.join(' | ')}`)
  }
  for (const warning of warnings) console.warn(`[security] ${warning}`)
} else if (!isTest && !isProd) {
  // Outside production: wildcards and malformed origins are still rejected; http://localhost is fine.
  const problems = [
    ...checkOriginList(csv(process.env.CMS_CORS_ORIGINS), { name: 'CMS_CORS_ORIGINS', production: false }),
    ...checkOriginList(csv(process.env.CMS_CSRF_ORIGINS), { name: 'CMS_CSRF_ORIGINS', production: false }),
  ]
  if (problems.length > 0) throw new Error(`Invalid origin configuration: ${problems.join(' | ')}`)
  if (!process.env.TURNSTILE_SECRET_KEY) {
    console.warn(
      "[security] TURNSTILE_SECRET_KEY is not set: public submissions use Cloudflare's always-pass TEST secret. " +
        'Spam protection is NOT active. Set a real secret before deploying.',
    )
  }
}

if (!isTest && !isBuildPhase) {
  // Counts only: never names or values of settings.
  const selfCheck = startupSelfCheck(process.env)
  console.log(`[startup] self-check: ${selfCheck.passed}/${selfCheck.total} critical settings present`)
  for (const warning of turnstileActionWarnings(process.env)) console.warn(`[security] ${warning}`)
}

// CMS_PUBLIC_URL is the origin the admin UI is served from. Payload adds serverURL to the CSRF
// allowlist itself; we also normalise it (no trailing slash) so the Origin comparison matches.
const serverURL = process.env.CMS_PUBLIC_URL ? normaliseOrigin(process.env.CMS_PUBLIC_URL) : undefined

// Password-reset e-mail: only when SMTP is configured. Without it Payload logs e-mails to the
// console (development only; in production configure SMTP or resets cannot be delivered).
const smtpHost = process.env.SMTP_HOST?.trim()
const email = smtpHost
  ? nodemailerAdapter({
      defaultFromAddress: process.env.EMAIL_FROM_ADDRESS || 'cms@localhost',
      defaultFromName: process.env.EMAIL_FROM_NAME || 'Church Times CMS',
      transportOptions: {
        host: smtpHost,
        port: Number.parseInt(process.env.SMTP_PORT ?? '', 10) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        requireTLS: process.env.SMTP_SECURE !== 'true' && isProd,
        // nodemailer defaults are 2 min (connect) and 10 min (socket): a hanging SMTP server must not pin requests or jobs.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        ...(process.env.SMTP_USER
          ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' } }
          : {}),
      },
    })
  : undefined

export default buildConfig({
  secret: secret || 'test-only-secret-not-for-production-use-0123456789',
  serverURL,
  // Explicit allowlist only (never '*'). Payload sends Access-Control-Allow-Credentials only for
  // origins in this list.
  cors: corsOrigins,
  // Cookie-authenticated requests whose Origin is not listed here (or serverURL) are treated as
  // anonymous. NOTE: an EMPTY list disables the check in Payload, so we always include the CMS's
  // own origin and fall back to the local dev origin.
  csrf: [...new Set([...csrfOrigins, ...(serverURL ? [serverURL] : isProd ? [] : ['http://localhost:3000'])])],
  ...(email ? { email } : {}),
  admin: {
    user: 'users',
    importMap: { baseDir: path.resolve(dirname) },
  },
  collections: [
    Users,
    Categories,
    Media,
    Articles,
    Submissions,
    ContactMessages,
    Subscribers,
    LiveEvents,
    LiveUpdates,
    Redirects,
    Advertisers,
    AdCampaigns,
    LegacyComments,
    AuditLogs,
    ...w12Collections,
  ],
  globals: [...w12Globals],
  endpoints: [
    publicSubmissionsEndpoint,
    publicSubmissionsPreflightEndpoint,
    publicRedirectsEndpoint,
    publicRedirectsHeadEndpoint,
    publicRedirectsPreflightEndpoint,
    publicContactEndpoint,
    publicContactPreflightEndpoint,
    ...newsletterEndpoints,
    publicAdvertisingEndpoint,
    publicAdvertisingHeadEndpoint,
    publicAdvertisingPreflightEndpoint,
    previewArticleEndpoint,
    ...publicSearchEndpoints,
    ...staffRelatedArticlesEndpoints,
    ...w12Endpoints,
    ...givingEndpoints,
  ],
  editor: lexicalEditor(),
  db: postgresAdapter({
    // PG_POOL_MAX: size of the PostgreSQL pool of this process (pg default 10). Size it with docs/performance.md.
    pool: { connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_POOL_MAX ?? '', 10) > 0 ? Number.parseInt(process.env.PG_POOL_MAX ?? '', 10) : 10 },
    migrationDir: path.resolve(dirname, 'migrations'),
    push: process.env.NODE_ENV !== 'production' && process.env.PAYLOAD_DB_PUSH === 'true',
  }),
  onInit: async (payload) => {
    startScheduler(payload)
  },
  sharp,
  // The parser limit is the largest allowed file (audio/video, MEDIA_AV_MAX_MB, default 100 MB); images are capped at MEDIA_IMAGE_MAX_MB (default 25 MB) in Media.checkUpload.
  upload: { limits: { fileSize: avMaxBytes() } },
  graphQL: { disable: true },
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
})
