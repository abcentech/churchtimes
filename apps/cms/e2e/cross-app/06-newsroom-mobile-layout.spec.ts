/**
 * Mobile layout of the real newsroom SPA: no view may force horizontal page scrolling at the Pixel 7 width (412 px).
 * Views listed in KNOWN_OVERFLOW overflow today (frontend gap, not patched here). `test.fail()` keeps the suite green
 * while the gap exists and turns red once it is fixed, which is the cue to remove the view from the list.
 */
import { expect, test } from '@playwright/test'

import { Evidence, getConfig } from './support/helpers'
import { gotoView, loginUi, requireNewsroom } from './support/newsroom'

const cfg = getConfig()
const KNOWN_OVERFLOW: string[] = [] // 'review' overflowed (544px layout) until the newsroom tab bar fix; now fixed

for (const view of ['dashboard', 'review', 'editor', 'media', 'live'] as const) {
  test(`newsroom ${view} view has no horizontal page overflow at the project viewport (REAL UI)`, async ({ page }, info) => {
    requireNewsroom(cfg)
    const mobile = info.project.name === 'android-pixel7'
    test.fail(mobile && KNOWN_OVERFLOW.includes(view), `KNOWN GAP: the ${view} view is wider than the 412px viewport`)
    const ev = new Evidence(cfg, info, `D-mobile-layout-${view}`)
    await loginUi(page, cfg, 'section-editor')
    await gotoView(page, view, (t) => ev.note(t))
    await page.waitForTimeout(1_000)
    const m = await page.evaluate(() => {
      const wide: string[] = []
      for (const e of Array.from(document.querySelectorAll('body *'))) {
        const b = (e as HTMLElement).getBoundingClientRect()
        if (b.right > document.documentElement.clientWidth + 1 && b.width > 0 && wide.length < 4) wide.push(`${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).slice(0, 32)} right=${Math.round(b.right)}`)
      }
      return { layoutWidth: window.innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, wide }
    })
    ev.note(`${view}: layout width ${m.layoutWidth}px, client ${m.clientWidth}px, scroll ${m.scrollWidth}px; first overflowing elements: ${m.wide.join(' | ') || 'none'}`)
    await ev.shot(page, `${view} view`, { final: true })
    expect(m.layoutWidth, `${view} forces a ${m.layoutWidth}px layout in a ${m.clientWidth}px viewport (${m.wide.join(' | ')})`).toBeLessThanOrEqual(m.clientWidth)
  })
}
