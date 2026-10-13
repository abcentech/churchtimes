/**
 * Canonical JSON comparison.
 *
 * PostgreSQL `jsonb` does not preserve key order (it stores keys sorted by length, then bytes), so
 * the same Lexical document read back from the database and sent by a client can serialise
 * differently. `JSON.stringify` equality then reports a "material edit" for unchanged content.
 * These helpers compare by value: object keys are sorted recursively, array order is significant.
 *
 * Semantics follow JSON: `undefined`, functions and symbols are dropped from objects and become
 * `null` in arrays and at the top level; non-finite numbers become `null`; `Date` serialises through
 * its `toJSON()`.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function normalise(value: unknown): Json | undefined {
  if (value === null || value === undefined) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value as string | boolean
  if (t === 'number') return Number.isFinite(value) ? (value as number) : null
  if (t === 'bigint') return String(value)
  if (t === 'function' || t === 'symbol') return undefined
  if (t === 'object') {
    const obj = value as { toJSON?: () => unknown }
    if (typeof obj.toJSON === 'function') return normalise(obj.toJSON())
    if (Array.isArray(value)) return value.map((v) => normalise(v) ?? null)
    const out: { [key: string]: Json } = {}
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v === undefined) continue
      const n = normalise(v)
      if (n !== undefined) out[key] = n
    }
    return out
  }
  return null
}

/** Deterministic JSON text: object keys sorted at every depth. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(normalise(value) ?? null)
}

/** Value equality that ignores object key order. `null` and `undefined` are the same absence at the top level. */
export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b)
}
