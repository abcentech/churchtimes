import fs from 'node:fs'
import path from 'node:path'

import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter'

import { evidenceLogName } from './helpers'
import { isRemote } from './remote'

/** Appends a PASS/FAIL line per test (and the failure message) to docs/evidence/cross-app-<date>.txt. */
export default class EvidenceReporter implements Reporter {
  private lines: string[] = []
  private dir = path.resolve(process.cwd(), 'docs', 'evidence', ...(isRemote ? ['remote'] : []))

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? '?'
    const expectedFail = test.outcome() === 'expected' && result.status === 'failed'
    const status = result.status === 'passed' || expectedFail ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL'
    this.lines.push(`${status}  [${project}] ${test.title}  (${Math.round(result.duration / 1000)}s)${expectedFail ? "  [expected failure: known gap still present]" : ""}`)
    if (status === 'FAIL' && !expectedFail) {
      const msg = (result.error?.message ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 8).join('\n        ')
      this.lines.push(`        ${msg}`)
    }
  }

  onEnd(result: FullResult): void {
    if (process.env.XAPP_KEEP_EVIDENCE === '0') return
    if (isRemote) {
      if (!this.lines.length) return // setup failed or --list: nothing ran, nothing to record
      fs.mkdirSync(this.dir, { recursive: true })
    }
    const file = path.join(this.dir, evidenceLogName())
    const counts = this.lines.filter((l) => /^(PASS|FAIL|SKIP)/.test(l)).reduce<Record<string, number>>((m, l) => ({ ...m, [l.slice(0, 4)]: (m[l.slice(0, 4)] ?? 0) + 1 }), {})
    fs.appendFileSync(
      file,
      ['', '=== RESULTS ===', ...this.lines, '', `Total: ${JSON.stringify(counts)}  overall: ${result.status}  finished ${new Date().toISOString()}`, ''].join('\n'),
    )
  }
}
