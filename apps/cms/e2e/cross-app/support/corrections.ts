import { expect, type Page } from '@playwright/test'

import type { Evidence, XappConfig } from './helpers'
import { gotoView, loginUi, logoutUi, press } from './newsroom'

/** Reporter writes a story in the newsroom UI and submits it for review (no image: the corrections journey does not need one). */
export async function reporterSubmitStory(page: Page, cfg: XappConfig, title: string, standfirst: string, body: string): Promise<number> {
  await loginUi(page, cfg, 'reporter')
  await page.goto(`${cfg.newsroomOrigin}/#editor`)
  await expect(page.getByTestId('editor-title')).toBeVisible()
  await page.getByTestId('editor-title').fill(title)
  await page.getByTestId('editor-standfirst').fill(standfirst)
  await page.getByTestId('editor-category').selectOption({ label: cfg.categoryTitle })
  await page.getByTestId('editor-body').fill(body)
  await page.getByTestId('editor-save-draft').click()
  await expect(page).toHaveURL(/#editor\?id=\d+/)
  const id = Number(/id=(\d+)/.exec(page.url())![1])
  await page.getByTestId('editor-submit-review').click()
  await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'in_review')
  await logoutUi(page)
  return id
}

/** Section editor approves and publishes the story from the review queue (real UI, same path as spec 02). */
export async function sectionEditorPublishStory(page: Page, cfg: XappConfig, ev: Evidence, title: string): Promise<void> {
  const note = (t: string) => ev.note(t)
  await loginUi(page, cfg, 'section-editor')
  await gotoView(page, 'review', note)
  const card = page.getByTestId('review-card').filter({ hasText: title })
  await expect(card).toBeVisible()
  await press(page, card.getByTestId('review-inspect'), note)
  await expect(page.getByTestId('inspect-modal')).toBeVisible()
  await press(page, page.getByTestId('inspect-approve'), note)
  await expect(page.getByTestId('inspect-modal')).toBeHidden()
  await press(page, page.getByTestId('review-tab-approved'), note)
  const approved = page.getByTestId('review-card').filter({ hasText: title })
  await expect(approved).toBeVisible()
  await press(page, approved.getByTestId('review-inspect'), note)
  await press(page, page.getByTestId('inspect-publish'), note)
  await press(page, page.getByTestId('publish-ok'), note)
  await expect(page.getByTestId('inspect-modal')).toBeHidden()
}

/** Corrections as the anonymous public API returns them: only the public fields may be present. */
export const PUBLIC_CORRECTION_KEYS = ['id', 'note', 'correctedAt']
