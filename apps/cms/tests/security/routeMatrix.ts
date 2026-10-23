/**
 * Anonymous access matrix for EVERY route the CMS exposes (docs/security.md "Adding a route").
 *
 * routes.test.ts enumerates the routes from `payload.config` (collections + endpoints) and from the Next route files
 * under src/app/(payload)/api, and FAILS when a route has no entry here, or an entry here no longer exists. The
 * recorded value is the set of HTTP statuses an ANONYMOUS caller (no cookie, no token) may receive for a bodiless
 * (or `{}`) request. A route that starts answering 200 anonymously must be added here deliberately, in review.
 */

export type Anon = number[]

/** Authentication-required: anonymous never reaches the data. */
export const DENIED: Anon = [401, 403]

export type CollectionOps = {
  /** GET /api/<slug> */ find: Anon
  /** GET /api/<slug>/:id */ findById: Anon
  /** GET /api/<slug>/count */ count: Anon
  /** POST /api/<slug> with {} */ create: Anon
  /** PATCH /api/<slug>/:id */ update: Anon
  /** DELETE /api/<slug>/:id */ delete: Anon
  /** GET /api/<slug>/versions */ versions: Anon
}

const staffOnly: CollectionOps = { find: DENIED, findById: DENIED, count: DENIED, create: DENIED, update: DENIED, delete: DENIED, versions: DENIED }
/** Readable anonymously (the result set is filtered by access control; asserted in content.test.ts). */
const publicRead = (extra: Partial<CollectionOps> = {}): CollectionOps => ({
  find: [200],
  findById: [200, 404],
  count: [200],
  create: DENIED,
  update: DENIED,
  delete: DENIED,
  versions: DENIED,
  ...extra,
})

export const collectionMatrix: Record<string, CollectionOps> = {
  users: staffOnly,
  categories: publicRead(),
  media: publicRead(),
  articles: publicRead(),
  submissions: staffOnly,
  'contact-messages': staffOnly,
  subscribers: staffOnly,
  'live-events': publicRead(),
  'live-updates': publicRead(),
  redirects: staffOnly,
  advertisers: staffOnly,
  'ad-campaigns': staffOnly,
  // Replaced by the public projection endpoint; `article` is mandatory (400 without it).
  'legacy-comments': publicRead({ find: [400, 200] }),
  'audit-logs': staffOnly,
  'payload-kv': staffOnly,
  'payload-locked-documents': staffOnly,
  // Payload internal: reads answer 200 with a null value, never data. Writes are refused.
  'payload-preferences': { find: DENIED, findById: [200, 404], count: [200, 404], create: DENIED, update: DENIED, delete: [401, 403], versions: [200, 404] },
  // Payload migrations bookkeeping: not exposed over REST at all.
  'payload-migrations': { find: [501], findById: [501], count: [501], create: [501], update: [501], delete: [501], versions: [501] },
}

/** Collection endpoint paths Payload itself registers for every collection: covered by `collectionMatrix`. */
export const GENERIC_COLLECTION_PATHS = new Set(['/', '/:id', '/count', '/versions', '/versions/:id', '/:id/duplicate', '/access/:id?'])

export type EndpointEntry = {
  /** Statuses an anonymous request may get (bodiless, or `{}` for POST). */
  anon: Anon
  /** Answers anonymous callers by design: its responses are walked for forbidden keys in content.test.ts. */
  public?: true
  note?: string
}

/** Key: `METHOD /api<path>` with `:param` placeholders exactly as registered. Collection endpoints include `/<slug>`. */
export const endpointMatrix: Record<string, EndpointEntry> = {
  // --- users / auth (Payload built-ins + ours)
  'POST /api/users/:id/revoke-sessions': { anon: DENIED },
  'POST /api/users/forgot-password': { anon: [200, 400], public: true, note: 'always neutral; rate limited' },
  'GET /api/users/init': { anon: [200], public: true, note: 'only says whether a user exists' },
  'POST /api/users/login': { anon: [400, 401], public: true, note: 'rate limited, locks out, generic error' },
  'POST /api/users/logout': { anon: [400, 401] },
  'GET /api/users/me': { anon: [200], public: true, note: '{ user: null } when anonymous' },
  'POST /api/users/refresh-token': { anon: [400, 401, 403] },
  'POST /api/users/first-register': { anon: DENIED, note: 'refused once a user exists (and unless ALLOW_FIRST_REGISTER)' },
  'POST /api/users/reset-password': { anon: [400, 403, 429], public: true },
  'POST /api/users/unlock': { anon: [400, 401, 403], note: 'admin only' },
  'POST /api/users/verify/:id': { anon: [404], note: 'e-mail verification is not enabled; refused in src/proxy.ts' },
  // --- articles / submissions / subscribers / live
  'POST /api/articles/:id/preview-token': { anon: [401] },
  'POST /api/submissions/:id/convert': { anon: DENIED },
  'GET /api/subscribers/export': { anon: DENIED },
  'POST /api/subscribers/:id/erase': { anon: DENIED },
  'GET /api/subscribers/:id/subject-data': { anon: DENIED },
  'GET /api/live-events/:slug/updates': { anon: [404], public: true, note: 'approved updates of a non-draft event' },
  'GET /api/media/paste-url/:id?': { anon: DENIED },
  'GET /api/media/file/:filename': { anon: [403, 404], note: 'public only for media that is on the public site' },
  'GET /api/payload-preferences/:key': { anon: [200], note: 'Payload internal; null value for anonymous' },
  'POST /api/payload-preferences/:key': { anon: DENIED },
  'DELETE /api/payload-preferences/:key': { anon: [401, 403] },
  // legacy-comments replaces the generic list route
  'GET /api/legacy-comments': { anon: [400, 200], public: true },
  'HEAD /api/legacy-comments': { anon: [400, 200], public: true },
  'OPTIONS /api/legacy-comments': { anon: [204, 200, 403], public: true },
  // --- public endpoints
  'POST /api/public/submissions': { anon: [400, 415, 403], public: true },
  'OPTIONS /api/public/submissions': { anon: [204], public: true },
  'GET /api/public/redirects': { anon: [200], public: true },
  'HEAD /api/public/redirects': { anon: [200], public: true },
  'OPTIONS /api/public/redirects': { anon: [204], public: true },
  'POST /api/public/contact': { anon: [415, 400, 403], public: true },
  'OPTIONS /api/public/contact': { anon: [204], public: true },
  'POST /api/public/newsletter/subscribe': { anon: [415, 400, 403], public: true },
  'POST /api/public/newsletter/confirm': { anon: [415, 400, 403], public: true },
  'POST /api/public/newsletter/unsubscribe': { anon: [415, 400, 403], public: true },
  'OPTIONS /api/public/newsletter/subscribe': { anon: [204], public: true },
  'OPTIONS /api/public/newsletter/confirm': { anon: [204], public: true },
  'OPTIONS /api/public/newsletter/unsubscribe': { anon: [204], public: true },
  'GET /api/public/newsletter/confirm': { anon: [405], public: true, note: 'method guard' },
  'PUT /api/public/newsletter/confirm': { anon: [405], public: true },
  'PATCH /api/public/newsletter/confirm': { anon: [405], public: true },
  'DELETE /api/public/newsletter/confirm': { anon: [405], public: true },
  'GET /api/public/newsletter/unsubscribe': { anon: [405], public: true },
  'PUT /api/public/newsletter/unsubscribe': { anon: [405], public: true },
  'PATCH /api/public/newsletter/unsubscribe': { anon: [405], public: true },
  'DELETE /api/public/newsletter/unsubscribe': { anon: [405], public: true },
  'GET /api/public/newsletter/subscribe': { anon: [405], public: true },
  'PUT /api/public/newsletter/subscribe': { anon: [405], public: true },
  'PATCH /api/public/newsletter/subscribe': { anon: [405], public: true },
  'DELETE /api/public/newsletter/subscribe': { anon: [405], public: true },
  'GET /api/public/advertising': { anon: [200], public: true },
  'HEAD /api/public/advertising': { anon: [200], public: true },
  'OPTIONS /api/public/advertising': { anon: [204], public: true },
  'GET /api/public/search': { anon: [200, 400], public: true },
  'HEAD /api/public/search': { anon: [200, 400], public: true },
  'OPTIONS /api/public/search': { anon: [204], public: true },
  'GET /api/preview/articles': { anon: [401], note: 'needs a signed, unexpired preview token' },
  // --- Payload built-ins that are not collection routes
  'GET /api/access': { anon: [200], note: "Payload: the caller's own permissions (anonymous: the public set)" },
  'GET /api/og': { anon: [200, 400, 401, 403, 404, 500], note: 'Payload admin OG-image helper; carries no data' },
}

/** Next route files under src/app/(payload)/api (relative to it) and the statuses an anonymous call may get. */
export const routeFileMatrix: Record<string, { method: string; anon: Anon; note: string }> = {
  'health/live/route.ts': { method: 'GET', anon: [200], note: 'liveness: static body, no DB' },
  'health/ready/route.ts': { method: 'GET', anon: [200, 503, 429], note: 'readiness: booleans only' },
  'graphql/route.ts': { method: 'POST', anon: [404, 405, 400, 403, 501], note: 'GraphQL is disabled (payload.config graphQL.disable)' },
  'graphql-playground/route.ts': { method: 'GET', anon: [404, 405, 400, 403, 501], note: 'playground disabled' },
  '[...slug]/route.ts': { method: 'GET', anon: [200, 401, 403, 404, 501], note: 'the REST catch-all (everything above)' },
}
