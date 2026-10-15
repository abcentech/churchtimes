import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Upload a picture through the newsroom media picker that is currently open (the "Upload a new photograph" form).
 * The picker selects the upload and closes by itself once the CMS answered 2xx.
 */
export async function uploadThroughPicker(page: Page, file: string, alt: string, extra: { credit?: string; caption?: string } = {}): Promise<void> {
  await expect(page.getByTestId('media-picker')).toBeVisible()
  await page.getByTestId('media-picker-upload-toggle').click()
  await page.getByTestId('media-upload-input').setInputFiles(file)
  await page.getByTestId('media-upload-alt').fill(alt)
  if (extra.credit) await page.getByTestId('media-upload-credit').fill(extra.credit)
  if (extra.caption) await page.getByTestId('media-upload-caption').fill(extra.caption)
  await page.getByTestId('media-upload-submit').click()
  await expect(page.getByTestId('media-picker')).toHaveCount(0)
}

/** Every <img> under the locator has really loaded (non-zero natural width), scrolling it into view first (lazy images). */
export async function expectImagesLoaded(images: Locator, expectedCount: number, message: string): Promise<void> {
  await expect(images).toHaveCount(expectedCount)
  for (let i = 0; i < expectedCount; i++) {
    const img = images.nth(i)
    await img.scrollIntoViewIfNeeded()
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { message: `${message} #${i + 1} loads`, timeout: 20_000 }).toBeGreaterThan(0)
  }
}

/** Put the caret of the story body right after `marker` (the next "Insert image" click places the image there). */
export async function placeCaretAfter(page: Page, marker: string): Promise<void> {
  await page.getByTestId('editor-body').evaluate((el: HTMLTextAreaElement, m: string) => {
    const at = el.value.indexOf(m)
    if (at < 0) throw new Error(`marker not found in the body: ${m}`)
    el.focus()
    el.setSelectionRange(at + m.length, at + m.length)
  }, marker)
}

/** The id stored in a Lexical upload node (the CMS may return the id or the populated media document). */
export const uploadNodeMediaId = (node: { value?: unknown }): number => {
  const v = node.value as { id?: number } | number | string
  return Number(typeof v === 'object' && v !== null ? v.id : v)
}

/** Reading order of an article body: paragraphs as "P:<start of text>", figures as "FIG:<alt>". */
export async function bodyReadingOrder(body: Locator): Promise<string[]> {
  return body.evaluate((el) =>
    Array.from(el.children).map((c) => {
      if (c.tagName === 'FIGURE') return `FIG:${c.querySelector('img')?.getAttribute('alt') ?? ''}`
      return `${c.tagName === 'P' ? 'P' : c.tagName}:${(c.textContent ?? '').slice(0, 40)}`
    }),
  )
}
