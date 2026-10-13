import {
  type Id,
  type UserLike,
  isEditorForCategory,
  isStaff,
  isTrustedPublisherForCategory,
} from '../access/roles'

export const ARTICLE_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'scheduled',
  'published',
  'archived',
] as const

export type ArticleStatus = (typeof ARTICLE_STATUSES)[number]

export const isArticleStatus = (v: unknown): v is ArticleStatus =>
  typeof v === 'string' && (ARTICLE_STATUSES as readonly string[]).includes(v)

export type TransitionResult = { ok: true } | { ok: false; status: 400 | 403; message: string }

export type TransitionInput = {
  user: UserLike | null | undefined
  from?: ArticleStatus | null
  to: ArticleStatus
  isAuthor: boolean
  categoryId?: Id | null | unknown
  isCreate?: boolean
  /** Scheduler (system) actor; only honoured for scheduled -> published. */
  system?: boolean
}

/** Who may perform an edge: author or editor / editor only / publish-class (editor or own trusted publisher). */
type Rule = 'author' | 'editor' | 'publish'

const EDGES: Record<ArticleStatus, Partial<Record<ArticleStatus, Rule>>> = {
  draft: { in_review: 'author', published: 'publish', scheduled: 'publish' },
  changes_requested: { in_review: 'author', draft: 'author' },
  in_review: {
    changes_requested: 'editor',
    approved: 'editor',
    published: 'publish',
    scheduled: 'publish',
  },
  approved: { published: 'publish', scheduled: 'publish', in_review: 'editor' },
  scheduled: { published: 'editor', approved: 'editor', draft: 'editor' },
  published: { archived: 'editor' },
  archived: { published: 'editor' },
}

/** Statuses a reporter can never reach. */
const REPORTER_FORBIDDEN: readonly ArticleStatus[] = [
  'approved',
  'published',
  'scheduled',
  'archived',
  'changes_requested',
]

const deny = (status: 400 | 403, message: string): TransitionResult => ({ ok: false, status, message })

export function canTransition(input: TransitionInput): TransitionResult {
  const { user, from, to, isAuthor, categoryId, isCreate = false, system = false } = input

  if (system) {
    if (from === 'scheduled' && to === 'published') return { ok: true }
    return deny(403, 'System actor may only move scheduled articles to published.')
  }
  if (!isStaff(user)) return deny(403, 'Not permitted.')
  if (!isArticleStatus(to)) return deny(400, `Unknown status "${String(to)}".`)
  if (!isCreate && from === to) return { ok: true }

  const editor = isEditorForCategory(user, categoryId)
  const trustedOwn = isAuthor && isTrustedPublisherForCategory(user, categoryId)
  const publishClass = editor || trustedOwn

  if (user?.role === 'reporter' && REPORTER_FORBIDDEN.includes(to)) {
    return deny(403, `Reporters cannot set status "${to}".`)
  }

  if (isCreate) {
    if (to === 'draft' || to === 'in_review') return { ok: true }
    if (to === 'published' || to === 'scheduled') {
      return publishClass ? { ok: true } : deny(403, `Not permitted to create an article as "${to}".`)
    }
    if (to === 'approved') {
      return editor ? { ok: true } : deny(403, 'Not permitted to create an approved article.')
    }
    return deny(400, `An article cannot be created as "${to}".`)
  }

  if (!isArticleStatus(from)) return deny(400, `Unknown current status "${String(from)}".`)
  const rule = EDGES[from][to]
  if (!rule) return deny(400, `Invalid transition ${from} -> ${to}.`)

  const allowed = rule === 'editor' ? editor : rule === 'author' ? editor || isAuthor : publishClass
  return allowed ? { ok: true } : deny(403, `Not permitted to move an article from ${from} to ${to}.`)
}

export type EditInput = {
  user: UserLike | null | undefined
  status: ArticleStatus | null | undefined
  isAuthor: boolean
  categoryId?: unknown
}

const AUTHOR_EDITABLE: readonly string[] = ['draft', 'changes_requested']

/**
 * Who may change article content (title/body/etc).
 * - editors in scope: any status
 * - trusted publisher: own article in scope, any status
 * - anyone else who is the author (reporter, or out-of-scope staff): own article only while
 *   draft / changes_requested (NOT in_review)
 */
export function canEditContent({ user, status, isAuthor, categoryId }: EditInput): boolean {
  if (!isStaff(user)) return false
  if (isEditorForCategory(user, categoryId)) return true
  if (isAuthor && isTrustedPublisherForCategory(user, categoryId)) return true
  return isAuthor && typeof status === 'string' && AUTHOR_EDITABLE.includes(status)
}
