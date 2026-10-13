import { commitTransaction, initTransaction, killTransaction } from 'payload'
import type { Endpoint, PayloadRequest } from 'payload'

import { isEditorForCategory, isEditorRole, type UserLike } from '../access/roles'
import { writeAuditLog } from '../lib/audit'
import { claimSubmissionForConversion } from '../lib/dbTransaction'
import { slugify } from '../lib/sanitize'

const err = (status: number, message: string, field?: string) =>
  Response.json({ ok: false, errors: [{ ...(field ? { field } : {}), message }] }, { status })

type LexicalNode = Record<string, unknown>

/** Minimal valid Lexical state: one paragraph per blank-line separated block. */
export function textToLexical(text: string) {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)

  const paragraph = (block: string): LexicalNode => {
    const children: LexicalNode[] = []
    block.split('\n').forEach((line, i) => {
      if (i > 0) children.push({ type: 'linebreak', version: 1 })
      if (line) {
        children.push({ type: 'text', text: line, format: 0, detail: 0, mode: 'normal', style: '', version: 1 })
      }
    })
    return { type: 'paragraph', format: '', indent: 0, version: 1, direction: 'ltr', textFormat: 0, children }
  }

  return {
    root: {
      type: 'root',
      format: '',
      indent: 0,
      version: 1,
      direction: 'ltr',
      children: (blocks.length ? blocks : ['']).map(paragraph),
    },
  }
}

async function uniqueSlug(req: PayloadRequest, title: string): Promise<string> {
  const base = slugify(title, 150, 'submission')
  for (let i = 1; i <= 50; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`
    const existing = await req.payload.find({
      collection: 'articles',
      where: { slug: { equals: candidate } },
      limit: 1,
      depth: 0,
      pagination: false,
      overrideAccess: true,
      req,
    })
    if (existing.docs.length === 0) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

export const convertSubmissionEndpoint: Endpoint = {
  path: '/:id/convert',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const user = req.user as UserLike | null
    if (!user) return err(401, 'Authentication required.')
    if (!isEditorRole(user)) return err(403, 'Only editors can convert submissions.')

    const id = String(req.routeParams?.id ?? '')
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return err(404, 'Submission not found.')

    let submission: Record<string, any> | null = null
    try {
      submission = (await req.payload.findByID({
        collection: 'submissions',
        id,
        depth: 0,
        overrideAccess: false,
        user,
        req,
      })) as Record<string, any>
    } catch {
      return err(404, 'Submission not found.')
    }
    if (!submission) return err(404, 'Submission not found.')
    if (submission.status === 'converted') return err(409, 'Submission has already been converted.')

    let payloadBody: unknown
    try {
      payloadBody = await req.json?.()
    } catch {
      return err(400, 'Request body must be valid JSON.')
    }
    const rawCategory = (payloadBody as { category?: unknown } | null)?.category
    const categoryId =
      typeof rawCategory === 'number' && Number.isInteger(rawCategory) && rawCategory > 0
        ? rawCategory
        : typeof rawCategory === 'string' && /^[1-9][0-9]{0,15}$/.test(rawCategory)
          ? Number(rawCategory)
          : undefined
    if (categoryId === undefined) return err(400, 'A valid category id is required.', 'category')

    const category = await req.payload
      .findByID({ collection: 'categories', id: categoryId, depth: 0, overrideAccess: true, req })
      .catch(() => null)
    if (!category) return err(400, 'Category does not exist.', 'category')

    if (!isEditorForCategory(user, categoryId)) return err(403, 'This category is outside your sections.')

    // Atomic conversion. Everything below runs in ONE transaction: the submission is claimed first
    // (UPDATE ... WHERE status <> 'converted'), so of two concurrent conversions exactly one gets the
    // row; the other waits for the row lock, then matches nothing and answers 409. If creating the
    // article fails, the rollback releases the claim and the submission stays convertible.
    // (The earlier read-then-check let both requests pass and create two articles.)
    const ownsTransaction = await initTransaction(req)
    try {
      const claimed = await claimSubmissionForConversion(req, Number(id))
      if (!claimed) {
        if (ownsTransaction) await killTransaction(req)
        return err(409, 'Submission has already been converted.')
      }

      const body = String(submission.body ?? '')
      const title = String(submission.title ?? '').slice(0, 240)
      const article = (await req.payload.create({
        collection: 'articles',
        data: {
          title,
          slug: await uniqueSlug(req, title),
          excerpt: body.replace(/\s+/g, ' ').trim().slice(0, 300),
          content: textToLexical(body),
          category: categoryId,
          status: 'draft',
          author: user.id,
          bylineName: submission.name,
        } as never,
        user: user as never,
        overrideAccess: false,
        req,
      })) as { id: number | string; slug: string }

      await req.payload.update({
        collection: 'submissions',
        id,
        data: { status: 'converted', article: article.id } as never,
        overrideAccess: true,
        req,
      })

      await writeAuditLog(req, {
        action: 'submission.convert',
        collection: 'submissions',
        docId: id,
        fromStatus: submission.status,
        toStatus: 'converted',
        summary: `Converted ${submission.reference} to article ${article.id}`,
        details: { articleId: article.id, category: categoryId },
      })

      if (ownsTransaction) await commitTransaction(req)
      return Response.json({ ok: true, article: { id: article.id, slug: article.slug } }, { status: 201 })
    } catch (e) {
      if (ownsTransaction) await killTransaction(req)
      req.payload.logger.error({ err: e }, 'submission convert failed')
      const status = (e as { status?: number })?.status
      if (status === 403) return err(403, 'You are not allowed to create this article.')
      if (status === 400) return err(400, (e as Error).message || 'Invalid article data.')
      return err(500, 'Could not convert the submission.')
    }
  },
}
