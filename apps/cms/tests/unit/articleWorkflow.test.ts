import { describe, expect, it } from 'vitest'

import {
  ARTICLE_STATUSES,
  type ArticleStatus,
  canEditContent,
  canTransition,
} from '../../src/workflow/articleWorkflow'

const A = 1 // category in scope
const B = 2 // category out of scope

const admin = { id: 1, role: 'admin' }
const eic = { id: 2, role: 'editor-in-chief' }
const se = { id: 3, role: 'section-editor', sections: [A] }
const tp = { id: 4, role: 'trusted-publisher', sections: [A] }
const reporter = { id: 5, role: 'reporter', sections: [A] }

type Case = [string, object | null, ArticleStatus, ArticleStatus, boolean, number, boolean]
// [label, user, from, to, isAuthor, category, expectedOk]
const cases: Case[] = [
  ['reporter submits own draft', reporter, 'draft', 'in_review', true, A, true],
  ['reporter submits other draft', reporter, 'draft', 'in_review', false, A, false],
  ['reporter resubmits after changes', reporter, 'changes_requested', 'in_review', true, A, true],
  ['reporter cannot approve own', reporter, 'in_review', 'approved', true, A, false],
  ['reporter cannot publish own', reporter, 'draft', 'published', true, A, false],
  ['reporter cannot schedule own', reporter, 'draft', 'scheduled', true, A, false],
  ['reporter cannot archive', reporter, 'published', 'archived', true, A, false],
  ['reporter cannot request changes', reporter, 'in_review', 'changes_requested', true, A, false],
  ['tp publishes own in scope', tp, 'draft', 'published', true, A, true],
  ['tp schedules own in scope', tp, 'in_review', 'scheduled', true, A, true],
  ['tp publishes approved own', tp, 'approved', 'published', true, A, true],
  ['tp out of scope cannot publish', tp, 'draft', 'published', true, B, false],
  ['tp cannot publish others', tp, 'draft', 'published', false, A, false],
  ['tp cannot approve', tp, 'in_review', 'approved', true, A, false],
  ['tp cannot archive', tp, 'published', 'archived', true, A, false],
  ['tp submits own draft', tp, 'draft', 'in_review', true, A, true],
  ['se approves in scope', se, 'in_review', 'approved', false, A, true],
  ['se requests changes in scope', se, 'in_review', 'changes_requested', false, A, true],
  ['se approves out of scope', se, 'in_review', 'approved', false, B, false],
  ['se publishes in scope', se, 'approved', 'published', false, A, true],
  ['se publishes out of scope', se, 'approved', 'published', true, B, false],
  ['se archives in scope', se, 'published', 'archived', false, A, true],
  ['se archives out of scope', se, 'published', 'archived', false, B, false],
  ['se unarchives', se, 'archived', 'published', false, A, true],
  ['se cancels schedule', se, 'scheduled', 'draft', false, A, true],
  ['se approved -> in_review', se, 'approved', 'in_review', false, A, true],
  ['eic anything in order', eic, 'in_review', 'approved', false, B, true],
  ['eic archives', eic, 'published', 'archived', false, B, true],
  ['admin schedules', admin, 'approved', 'scheduled', false, B, true],
  ['invalid: draft -> approved', admin, 'draft', 'approved', false, A, false],
  ['invalid: published -> draft', admin, 'published', 'draft', false, A, false],
  ['invalid: archived -> draft', admin, 'archived', 'draft', false, A, false],
  ['anonymous denied', null, 'draft', 'in_review', true, A, false],
  ['unknown role denied', { id: 9, role: 'visitor' }, 'draft', 'in_review', true, A, false],
]

describe('canTransition matrix', () => {
  it.each(cases)('%s', (_label, user, from, to, isAuthor, categoryId, ok) => {
    const res = canTransition({ user: user as never, from, to, isAuthor, categoryId })
    expect(res.ok).toBe(ok)
  })

  it('returns 403 for permission failures and 400 for invalid edges', () => {
    const forbidden = canTransition({ user: reporter, from: 'in_review', to: 'approved', isAuthor: true, categoryId: A })
    expect(forbidden).toMatchObject({ ok: false, status: 403 })
    const invalid = canTransition({ user: admin, from: 'draft', to: 'approved', isAuthor: false, categoryId: A })
    expect(invalid).toMatchObject({ ok: false, status: 400 })
  })

  it('same status is a no-op for staff, never for non-staff', () => {
    for (const s of ARTICLE_STATUSES) {
      expect(canTransition({ user: reporter, from: s, to: s, isAuthor: false, categoryId: B }).ok).toBe(true)
      expect(canTransition({ user: null, from: s, to: s, isAuthor: false }).ok).toBe(false)
    }
  })

  it('system flag only allows scheduled -> published', () => {
    expect(canTransition({ user: null, from: 'scheduled', to: 'published', isAuthor: false, system: true }).ok).toBe(true)
    for (const to of ARTICLE_STATUSES.filter((s) => s !== 'published')) {
      expect(canTransition({ user: null, from: 'scheduled', to, isAuthor: false, system: true }).ok).toBe(false)
    }
    expect(canTransition({ user: null, from: 'draft', to: 'published', isAuthor: false, system: true }).ok).toBe(false)
    // without the flag, an anonymous caller can't do it
    expect(canTransition({ user: null, from: 'scheduled', to: 'published', isAuthor: false }).ok).toBe(false)
  })

  describe('create', () => {
    const create = (user: object, to: ArticleStatus, isAuthor = true, categoryId = A) =>
      canTransition({ user: user as never, to, isAuthor, categoryId, isCreate: true }).ok
    it('any staff may create draft / in_review', () => {
      for (const u of [admin, eic, se, tp, reporter]) {
        expect(create(u, 'draft')).toBe(true)
        expect(create(u, 'in_review')).toBe(true)
      }
    })
    it('publish/schedule on create follows scope rules', () => {
      expect(create(reporter, 'published')).toBe(false)
      expect(create(reporter, 'scheduled')).toBe(false)
      expect(create(tp, 'published')).toBe(true)
      expect(create(tp, 'published', true, B)).toBe(false)
      expect(create(se, 'scheduled', false)).toBe(true)
      expect(create(se, 'published', false, B)).toBe(false)
      expect(create(eic, 'published', false, B)).toBe(true)
    })
    it('cannot create archived / changes_requested', () => {
      expect(create(admin, 'archived')).toBe(false)
      expect(create(admin, 'changes_requested')).toBe(false)
    })
  })
})

describe('canEditContent', () => {
  const edit = (user: object | null, status: ArticleStatus, isAuthor: boolean, categoryId = A) =>
    canEditContent({ user: user as never, status, isAuthor, categoryId })

  it('reporter: own only, draft/changes_requested only', () => {
    expect(edit(reporter, 'draft', true)).toBe(true)
    expect(edit(reporter, 'changes_requested', true)).toBe(true)
    expect(edit(reporter, 'in_review', true)).toBe(false)
    expect(edit(reporter, 'approved', true)).toBe(false)
    expect(edit(reporter, 'published', true)).toBe(false)
    expect(edit(reporter, 'draft', false)).toBe(false)
  })
  it('editors in scope: any status', () => {
    for (const s of ARTICLE_STATUSES) {
      expect(edit(admin, s, false, B)).toBe(true)
      expect(edit(eic, s, false, B)).toBe(true)
      expect(edit(se, s, false, A)).toBe(true)
    }
    expect(edit(se, 'published', false, B)).toBe(false)
    expect(edit(se, 'draft', true, B)).toBe(true) // own draft out of scope behaves like a reporter
    expect(edit(se, 'in_review', true, B)).toBe(false)
  })
  it('trusted publisher: own in scope any status', () => {
    expect(edit(tp, 'published', true, A)).toBe(true)
    expect(edit(tp, 'in_review', true, A)).toBe(true)
    expect(edit(tp, 'published', false, A)).toBe(false)
    expect(edit(tp, 'published', true, B)).toBe(false)
  })
  it('non-staff never', () => {
    expect(edit(null, 'draft', true)).toBe(false)
  })
})
