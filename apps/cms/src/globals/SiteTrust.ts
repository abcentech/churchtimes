import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { APIError } from 'payload'
import type { GlobalBeforeValidateHook, GlobalConfig } from 'payload'

import { isEditorInChief, isStaff, type UserLike } from '../access/roles'
import { findEmbedProblem } from '../lib/lexicalEmbeds'
import { plainTextValidator } from '../lib/newsroomFields'

const asUser = (u: unknown): UserLike | null => (u ? (u as UserLike) : null)

export const SITE_TRUST_RICH_FIELDS = ['editorialStandards', 'ownershipFunding', 'ethicsCorrectionsPolicy'] as const
export const CONTACT_EDITORS_MAX = 1000

/**
 * Text only: headings, paragraphs, lists, quotes, bold/italic and links. No uploads or relationships (an image here would
 * not be public, see Media read access) and no blocks.
 */
export const trustPageEditor = lexicalEditor({
  features: ({ defaultFeatures }) => defaultFeatures.filter((f) => !['upload', 'relationship', 'blocks', 'inlineBlocks'].includes(f.key)),
})

/** Unsafe links (javascript:, data:, ...) and any embed or block are refused (400), same rule as article bodies. */
const validateTrustText: GlobalBeforeValidateHook = ({ data }) => {
  for (const key of SITE_TRUST_RICH_FIELDS) {
    const value = (data as Record<string, unknown> | undefined)?.[key]
    if (value === undefined || value === null) continue
    const problem = findEmbedProblem(value)
    if (problem) throw new APIError(problem, 400)
  }
  return data
}

/**
 * Editorial standards, ownership and funding, ethics and corrections policy (Agent A's trust pages). Staff read it in the
 * admin; readers get it from `GET /api/public/site-trust` only once `published` is ticked. Write: admin / editor-in-chief.
 */
export const SiteTrust: GlobalConfig = {
  slug: 'site-trust',
  label: 'Site trust pages',
  admin: { group: 'Newsroom', description: 'Text of the public trust pages: editorial standards, ownership and funding, ethics and corrections.' },
  access: {
    read: ({ req }) => isStaff(asUser(req.user)),
    update: ({ req }) => isEditorInChief(asUser(req.user)),
  },
  hooks: { beforeValidate: [validateTrustText] },
  fields: [
    {
      name: 'published',
      type: 'checkbox',
      defaultValue: false,
      admin: { position: 'sidebar', description: 'Show these pages to readers. Untick to take them down.' },
    },
    { name: 'editorialStandards', type: 'richText', editor: trustPageEditor, label: 'Editorial standards' },
    { name: 'ownershipFunding', type: 'richText', editor: trustPageEditor, label: 'Ownership and funding' },
    { name: 'ethicsCorrectionsPolicy', type: 'richText', editor: trustPageEditor, label: 'Ethics and corrections policy' },
    {
      name: 'contactEditors',
      type: 'textarea',
      maxLength: CONTACT_EDITORS_MAX,
      validate: plainTextValidator('Contact the editors', CONTACT_EDITORS_MAX, { multiline: true }),
      admin: { description: 'Plain text: how readers reach the editors (address, e-mail, phone).' },
    },
  ],
}
