import type { Access, FieldAccess } from 'payload'

export const ROLES = [
  'admin',
  'editor-in-chief',
  'section-editor',
  'trusted-publisher',
  'reporter',
] as const

export type Role = (typeof ROLES)[number]

export type Id = number | string

/** Loosely typed user so this file compiles independent of generated types. */
export type UserLike = {
  id?: Id
  role?: string | null
  sections?: unknown
  [key: string]: unknown
}

type MaybeUser = UserLike | null | undefined

/** Normalize a relationship value (id or populated object) to its id. */
export const idOf = (value: unknown): Id | undefined => {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number' || typeof value === 'string') return value
  if (typeof value === 'object' && 'id' in (value as Record<string, unknown>)) {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'number' || typeof id === 'string') return id
  }
  return undefined
}

const sameId = (a: Id | undefined, b: Id | undefined): boolean =>
  a !== undefined && b !== undefined && String(a) === String(b)

export const isStaff = (user: MaybeUser): boolean =>
  Boolean(user && typeof user.role === 'string' && (ROLES as readonly string[]).includes(user.role))

export const isAdmin = (user: MaybeUser): boolean => Boolean(user && user.role === 'admin')

/** admin or editor-in-chief */
export const isEditorInChief = (user: MaybeUser): boolean =>
  Boolean(user && (user.role === 'admin' || user.role === 'editor-in-chief'))

/** admin | editor-in-chief | section-editor */
export const isEditorRole = (user: MaybeUser): boolean =>
  Boolean(
    user &&
      (user.role === 'admin' || user.role === 'editor-in-chief' || user.role === 'section-editor'),
  )

export const userSectionIds = (user: MaybeUser): Id[] => {
  const raw = user?.sections
  if (!Array.isArray(raw)) return []
  return raw.map(idOf).filter((v): v is Id => v !== undefined)
}

const inSections = (user: MaybeUser, categoryId: unknown): boolean => {
  const cid = idOf(categoryId)
  if (cid === undefined) return false
  return userSectionIds(user).some((s) => sameId(s, cid))
}

/** Editor "in scope": admin/EIC for everything, section-editor for their sections. */
export const isEditorForCategory = (user: MaybeUser, categoryId: unknown): boolean => {
  if (!user) return false
  if (isEditorInChief(user)) return true
  if (user.role === 'section-editor') return inSections(user, categoryId)
  return false
}

export const isTrustedPublisherForCategory = (user: MaybeUser, categoryId: unknown): boolean =>
  Boolean(user && user.role === 'trusted-publisher' && inSections(user, categoryId))

// ---- Payload access helpers ----

export const anyone: Access = () => true
export const staffOnly: Access = ({ req }) => isStaff(req.user as MaybeUser)
export const adminOnly: Access = ({ req }) => isAdmin(req.user as MaybeUser)
export const editorInChiefOnly: Access = ({ req }) => isEditorInChief(req.user as MaybeUser)

export const fieldAdminOnly: FieldAccess = ({ req }) => isAdmin(req.user as MaybeUser)
