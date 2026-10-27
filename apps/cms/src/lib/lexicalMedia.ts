/**
 * Walks a Lexical document (any JSON shape) and returns every `upload` node, in document order.
 * Pure and defensive: it never throws on malformed input and bounds the depth.
 */
export type UploadNode = { relationTo: unknown; value: unknown }

const MAX_DEPTH = 64

export function collectUploadNodes(content: unknown): UploadNode[] {
  const found: UploadNode[] = []
  const walk = (node: unknown, depth: number) => {
    if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1)
      return
    }
    const rec = node as Record<string, unknown>
    if (rec.type === 'upload') found.push({ relationTo: rec.relationTo, value: rec.value })
    for (const key of Object.keys(rec)) {
      const child = rec[key]
      if (child !== null && typeof child === 'object') walk(child, depth + 1)
    }
  }
  walk(content, 0)
  return found
}

/** The id of an upload node value: a number, or a populated media object carrying one. */
export const uploadValueId = (value: unknown): unknown =>
  value !== null && typeof value === 'object' && 'id' in (value as object) ? (value as { id: unknown }).id : value
