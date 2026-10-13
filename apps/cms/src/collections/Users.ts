import { ValidationError } from 'payload'
import type {
  CollectionAfterChangeHook,
  CollectionBeforeOperationHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  Endpoint,
  PayloadRequest,
} from 'payload'

import {
  adminOnly,
  fieldAdminOnly,
  isAdmin,
  isEditorInChief,
  isStaff,
  ROLES,
  type UserLike,
} from '../access/roles'
import { writeAuditLog } from '../lib/audit'
import { authRateLimitHook } from '../lib/authRateLimit'
import { checkPasswordPolicy } from '../lib/passwordPolicy'

const isProd = process.env.NODE_ENV === 'production'

/** Session / JWT lifetime. Sessions are stored in the database (`useSessions`), see docs/security.md. */
export const TOKEN_EXPIRATION_SECONDS = 60 * 60 * 8
/** Password-reset link lifetime (ms). */
export const RESET_EXPIRATION_MS = 60 * 60 * 1000

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const publicBaseUrl = (req: PayloadRequest): string =>
  (process.env.CMS_PUBLIC_URL || req.payload.config.serverURL || 'http://localhost:3000').replace(/\/+$/, '')

const policyError = (message: string): never => {
  throw new ValidationError({ collection: 'users', errors: [{ message, path: 'password' }] })
}

/**
 * Password policy on reset. (Payload's reset operation never exposes the new password to
 * collection `beforeValidate` hooks - they only see the stored hash - so the policy for reset has
 * to run here, before the operation starts.)
 */
const resetPasswordPolicy: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== 'resetPassword') return args
  const data = (args as { data?: { token?: unknown; password?: unknown } }).data
  if (typeof data?.password !== 'string') return args // Payload answers 400 "Missing required data."

  let email: unknown
  let name: unknown
  if (typeof data.token === 'string' && data.token) {
    try {
      const user = (await req.payload.db.findOne({
        collection: 'users',
        req,
        where: { resetPasswordToken: { equals: data.token } },
      })) as { email?: string; name?: string } | null
      email = user?.email
      name = user?.name
    } catch {
      // unknown token: Payload rejects it with its own error right after
    }
  }
  const message = checkPasswordPolicy(data.password, { email, name })
  if (message) policyError(message)
  return args
}

/** Password policy on create and on password change; first registered user is always an admin. */
const enforcePasswordAndBootstrap: CollectionBeforeValidateHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (!data) return data

  if (typeof data.password === 'string' && data.password !== '') {
    const message = checkPasswordPolicy(data.password, {
      email: data.email ?? originalDoc?.email,
      name: data.name ?? originalDoc?.name,
    })
    if (message) policyError(message)
  }

  // /api/users/first-register on an empty database. Payload creates that user with
  // overrideAccess, so without this the role would come straight from the (unauthenticated)
  // request body or silently default to "reporter" and nobody could ever administer the CMS.
  if (operation === 'create' && !req.user && req.payloadAPI === 'REST') {
    const existing = await req.payload.count({ collection: 'users', overrideAccess: true, req })
    if (existing.totalDocs === 0) {
      data.role = 'admin'
      data.sections = []
    }
  }
  return data
}

const sectionKey = (v: unknown): string =>
  JSON.stringify(
    (Array.isArray(v) ? v : [])
      .map((s) => (typeof s === 'object' && s ? (s as { id?: unknown }).id : s))
      .map(String)
      .sort(),
  )

const auditUserChanges: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
  if ((req.context as { seed?: boolean } | undefined)?.seed === true) return doc
  if (operation === 'create') {
    await writeAuditLog(req, {
      action: 'user.create',
      collection: 'users',
      docId: doc.id,
      toStatus: doc.role,
      summary: `User ${doc.email} created with role ${doc.role}`,
    })
  } else if (
    previousDoc &&
    (previousDoc.role !== doc.role || sectionKey(previousDoc.sections) !== sectionKey(doc.sections))
  ) {
    await writeAuditLog(req, {
      action: 'user.role-change',
      collection: 'users',
      docId: doc.id,
      fromStatus: previousDoc.role,
      toStatus: doc.role,
      summary: `User ${doc.email} role ${previousDoc.role} -> ${doc.role}`,
    })
  }
  return doc
}

/**
 * POST /api/users/:id/revoke-sessions (admin only): signs the user out everywhere by deleting all of
 * their server-side sessions. Existing JWTs stop working immediately (Payload checks the session id
 * on every request when `useSessions` is on).
 */
const revokeSessionsEndpoint: Endpoint = {
  path: '/:id/revoke-sessions',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const fail = (status: number, message: string) =>
      Response.json({ ok: false, errors: [{ message }] }, { status, headers: { 'Cache-Control': 'no-store' } })
    if (!req.user) return fail(401, 'Authentication required.')
    if (!isAdmin(req.user as unknown as UserLike)) return fail(403, 'Only admins can revoke sessions.')

    const id = String(req.routeParams?.id ?? '')
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(404, 'User not found.')
    const target = await req.payload.db
      .findOne({ collection: 'users', req, where: { id: { equals: id } } })
      .catch(() => null)
    if (!target) return fail(404, 'User not found.')

    await req.payload.db.updateOne({
      id,
      collection: 'users',
      data: { sessions: [], updatedAt: null },
      req,
      returning: false,
    })
    await writeAuditLog(req, {
      action: 'user.revoke-sessions',
      collection: 'users',
      docId: id,
      summary: `Sessions revoked for ${(target as { email?: string }).email ?? id}`,
    })
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  },
}

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'email', 'role'],
  },
  endpoints: [revokeSessionsEndpoint],
  auth: {
    // Account lockout: 5 failed logins lock the account for 10 minutes.
    maxLoginAttempts: 5,
    lockTime: 600000,
    // JWT + DB session lifetime. Shorter than a working day; /api/users/refresh extends it.
    tokenExpiration: TOKEN_EXPIRATION_SECONDS,
    // Server-side sessions: logout, password change/reset and lockouts revoke tokens immediately.
    useSessions: true,
    cookies: {
      // Admin is served same-origin. Lax (not Strict) so links to /admin from e-mail or chat
      // still arrive logged in; state-changing requests are additionally guarded by the `csrf`
      // origin allowlist. Domain is deliberately unset (host-only cookie).
      secure: isProd,
      sameSite: 'Lax',
    },
    forgotPassword: {
      expiration: RESET_EXPIRATION_MS,
      // Payload also refuses a second reset e-mail for the same account within this window.
      minRequestInterval: 15_000,
      generateEmailSubject: () => 'Reset your Church Times CMS password',
      generateEmailHTML: (args) => {
        const base = args?.req ? publicBaseUrl(args.req as PayloadRequest) : 'http://localhost:3000'
        const url = `${base}/admin/reset/${encodeURIComponent(String(args?.token ?? ''))}`
        const name = escapeHtml(String((args?.user as { name?: string } | undefined)?.name ?? 'there'))
        return `<p>Hello ${name},</p>
<p>We received a request to reset the password for your Church Times CMS account.</p>
<p><a href="${escapeHtml(url)}">Choose a new password</a></p>
<p>This link works once and expires in 1 hour. If the link does not work, copy this address into your browser:<br>${escapeHtml(url)}</p>
<p>If you did not ask for this, ignore this e-mail; your password has not changed.</p>`
      },
    },
  },
  access: {
    admin: ({ req }) => isStaff(req.user as UserLike | null),
    create: adminOnly,
    // Payload's default lets ANY logged-in user unlock ANY account; that would defeat the lockout.
    unlock: adminOnly,
    read: ({ req }) => {
      const user = req.user as UserLike | null
      if (!user) return false
      if (isEditorInChief(user)) return true
      return { id: { equals: user.id } }
    },
    update: ({ req }) => {
      const user = req.user as UserLike | null
      if (!user) return false
      if (isAdmin(user)) return true
      return { id: { equals: user.id } }
    },
    delete: adminOnly,
  },
  hooks: {
    beforeOperation: [
      authRateLimitHook('login'),
      authRateLimitHook('forgotPassword'),
      authRateLimitHook('resetPassword'),
      resetPasswordPolicy,
    ],
    beforeValidate: [enforcePasswordAndBootstrap],
    afterChange: [auditUserChanges],
  },
  fields: [
    { name: 'name', type: 'text', required: true },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'reporter',
      saveToJWT: true,
      options: ROLES.map((r) => ({ label: r, value: r })),
      access: { create: fieldAdminOnly, update: fieldAdminOnly },
    },
    {
      name: 'sections',
      type: 'relationship',
      relationTo: 'categories',
      hasMany: true,
      saveToJWT: true,
      admin: {
        description: 'Categories this user edits (section-editor) or may publish in (trusted-publisher).',
      },
      access: { create: fieldAdminOnly, update: fieldAdminOnly },
    },
  ],
}
