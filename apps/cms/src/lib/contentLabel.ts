import { CONTENT_TYPE_LABELS, contentTypeOf } from './newsroomFields'

/**
 * Card labels outside the article page (digest, WhatsApp brief, share card). Non-news content types are always named
 * (Sponsored, Opinion, Analysis, Explainer, Fact-check), so a paid placement or an opinion piece is never presented as
 * plain news anywhere it travels. Same rule as the public cards (src/main.js reportCard, topic pages).
 */
export function contentTypeLabel(contentType: unknown): string {
  const type = contentTypeOf(contentType)
  return type === 'news' ? '' : CONTENT_TYPE_LABELS[type]
}

/** `Type · detail`, the type alone, or the detail alone (e.g. category or kicker). Empty when neither exists. */
export function storyLabel(contentType: unknown, detail: string | null | undefined): string {
  return [contentTypeLabel(contentType), detail ?? ''].filter(Boolean).join(' · ')
}
