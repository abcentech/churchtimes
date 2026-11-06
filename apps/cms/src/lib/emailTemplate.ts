/**
 * Strict e-mail HTML. `html` is a tagged template: every interpolated value is escaped unless it is already a
 * TrustedEmailHtml produced by this module. No caller can hand in markup from the CMS, a reader or an import:
 * article titles, excerpts and names are always text. URLs are interpolated through `safeHref` only.
 */

declare const trusted: unique symbol
export type TrustedEmailHtml = string & { readonly [trusted]: true }

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c] as string)

const trustedValues = new WeakSet<object>()
/** Boxed so that a plain string with the same text can never be mistaken for trusted markup. */
class Fragment {
  constructor(readonly value: string) {
    trustedValues.add(this)
  }
  toString(): string {
    return this.value
  }
}

type Interpolation = string | number | null | undefined | Fragment | Fragment[]

function part(value: Interpolation): string {
  if (Array.isArray(value)) return value.map(part).join('')
  if (value instanceof Fragment && trustedValues.has(value)) return value.value
  if (value === null || value === undefined) return ''
  return escapeHtml(value)
}

/** Escaping template tag. Returns a Fragment usable inside other `html` templates. */
export function html(strings: TemplateStringsArray, ...values: Interpolation[]): Fragment {
  let out = strings[0] ?? ''
  for (let i = 0; i < values.length; i++) out += part(values[i]) + (strings[i + 1] ?? '')
  return new Fragment(out)
}

/** Only http(s) URLs (absolute) reach an href; anything else becomes `#`. Escaped on interpolation. */
export function safeHref(url: unknown): string {
  if (typeof url !== 'string' || url.length > 2000) return '#'
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '#'
  } catch {
    return '#'
  }
}

/** Final document. The only producer of TrustedEmailHtml. */
export function renderDocument(fragment: Fragment): TrustedEmailHtml {
  if (!(fragment instanceof Fragment) || !trustedValues.has(fragment)) throw new Error('Untrusted e-mail HTML.')
  return fragment.value as TrustedEmailHtml
}

export type { Fragment as EmailFragment }
