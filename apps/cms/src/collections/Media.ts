import { APIError } from 'payload'
import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeOperationHook,
  CollectionConfig,
} from 'payload'

import { anyone, editorInChiefOnly, staffOnly } from '../access/roles'
import { writeAuditLog } from '../lib/audit'

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const

/** Returns the mimetype implied by magic bytes, or null when not a supported image. */
export function sniffImageMime(buf: Uint8Array): (typeof ALLOWED_MIME)[number] | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (
    buf.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => buf[i] === b)
  ) {
    return 'image/png'
  }
  if (
    buf.length >= 12 &&
    String.fromCharCode(...buf.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...buf.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

/** Safe filename: ascii letters, digits, dot, dash, underscore; bounded length; never hidden. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot + 1) : ''
  const clean = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
  const safeStem = clean(stem).slice(0, 100) || 'image'
  const safeExt = clean(ext).toLowerCase().slice(0, 5)
  return safeExt ? `${safeStem}.${safeExt}` : safeStem
}

const checkUpload: CollectionBeforeOperationHook = ({ args, operation }) => {
  if (operation !== 'create' && operation !== 'update') return args
  const file = (args.req as { file?: { name: string; data?: Uint8Array; mimetype?: string } }).file
  if (!file) return args
  file.name = sanitizeFilename(file.name)
  if (file.data && file.data.length > 0) {
    const sniffed = sniffImageMime(file.data)
    if (!sniffed) throw new APIError('Unsupported or corrupt image. Use JPEG, PNG or WebP.', 400)
    if (file.mimetype && file.mimetype !== sniffed) {
      throw new APIError('File content does not match its declared type.', 400)
    }
  }
  return args
}

const auditUpload: CollectionAfterChangeHook = async ({ doc, operation, req }) => {
  if ((req.context as { seed?: boolean } | undefined)?.seed === true) return doc
  if (operation === 'create') {
    await writeAuditLog(req, {
      action: 'upload',
      collection: 'media',
      docId: doc.id,
      summary: String(doc.filename ?? ''),
    })
  }
  return doc
}

const auditDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
  await writeAuditLog(req, {
    action: 'delete',
    collection: 'media',
    docId: doc.id,
    summary: String(doc.filename ?? ''),
  })
  return doc
}

export const Media: CollectionConfig = {
  slug: 'media',
  admin: { useAsTitle: 'filename', defaultColumns: ['filename', 'alt', 'credit', 'createdAt'] },
  access: {
    read: anyone,
    create: staffOnly,
    update: staffOnly,
    delete: editorInChiefOnly,
  },
  hooks: {
    beforeOperation: [checkUpload],
    afterChange: [auditUpload],
    afterDelete: [auditDelete],
  },
  upload: {
    staticDir: 'media',
    mimeTypes: [...ALLOWED_MIME],
    focalPoint: true,
    imageSizes: [
      { name: 'thumbnail', width: 400 },
      { name: 'card', width: 800 },
      { name: 'hero', width: 1600, formatOptions: { format: 'webp' } },
    ],
  },
  fields: [
    { name: 'alt', type: 'text', required: true, maxLength: 300 },
    { name: 'caption', type: 'text' },
    { name: 'credit', type: 'text' },
  ],
}
