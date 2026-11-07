/**
 * Secondary categories of an article (`articles.categories`, owner decision: articles can sit in several sections).
 * `articles.category` stays the PRIMARY category (required; canonical listing, breadcrumbs, sitemap, scoping). The extras are
 * an optional list: at most MAX_SECONDARY_CATEGORIES, no duplicates, never the primary. Pure so it is unit tested.
 */
export const MAX_SECONDARY_CATEGORIES = 5

const idKey = (v: unknown): string | null => {
  const raw = v && typeof v === 'object' ? (v as { id?: unknown }).id : v
  if (typeof raw === 'number' && Number.isInteger(raw)) return String(raw)
  if (typeof raw === 'string' && /^\d{1,15}$/.test(raw.trim())) return String(Number(raw))
  return null
}

/** Ids (as strings) of a relationship list value; ignores nulls. */
export function categoryIds(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const v of list) {
    const k = idKey(v)
    if (k !== null) out.push(k)
  }
  return out
}

/** An error message, or null when `categories` is acceptable next to the primary `category`. */
export function checkSecondaryCategories(primary: unknown, list: unknown): string | null {
  if (list === undefined || list === null) return null
  if (!Array.isArray(list)) return 'Additional categories must be a list.'
  if (list.length > MAX_SECONDARY_CATEGORIES) return `An article can have at most ${MAX_SECONDARY_CATEGORIES} additional categories.`
  const ids = list.map(idKey)
  if (ids.some((k) => k === null)) return 'Additional categories must be category IDs.'
  if (new Set(ids).size !== ids.length) return 'Additional categories must not repeat a category.'
  const p = idKey(primary)
  if (p !== null && ids.includes(p)) return 'The primary category must not also be listed in the additional categories.'
  return null
}
