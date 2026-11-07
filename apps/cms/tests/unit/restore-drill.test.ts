/**
 * Static guards for the restore drill (scripts/restore-drill.sh and .github/workflows/restore-drill.yml).
 * The drill itself needs Docker and runs in CI only; these tests keep its safety properties from regressing.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = fs.readFileSync(path.resolve(here, '../../scripts/restore-drill.sh'), 'utf8')
const workflow = fs.readFileSync(path.resolve(here, '../../../../.github/workflows/restore-drill.yml'), 'utf8')

describe('restore drill', () => {
  it('script is valid bash', () => {
    const r = spawnSync('bash', ['-n', path.resolve(here, '../../scripts/restore-drill.sh')], { encoding: 'utf8' })
    if (r.error) return // no bash on this machine
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('never prints a secret, enables tracing, or passes the admin password as an argument', () => {
    expect(script).toMatch(/^set \+x$/m)
    expect(script).not.toMatch(/set -[a-z]*x/)
    expect(script).not.toMatch(/^\s*(echo|log|fail)\b.*\$\{?(PGPW|SECRET_[ABC]|SALT|ADMIN_NEW_PASSWORD|SECRETS)\b/m)
    expect(script).not.toMatch(/-e ADMIN_NEW_PASSWORD=/)
  })

  it('asserts the tamper tests, the wipe and the production ALLOW_FIRST_REGISTER default', () => {
    expect(script).toContain('ACCEPTED a backup with a corrupted')
    expect(script).toContain('down -v')
    expect(script).not.toMatch(/^ALLOW_FIRST_REGISTER=/m)
  })

  it('workflow runs nightly, manually and on pull requests limited to the drill paths, with no secrets context', () => {
    expect(workflow).toMatch(/schedule:/)
    expect(workflow).toMatch(/workflow_dispatch:/)
    expect(workflow).toMatch(/pull_request:/)
    expect(workflow).toContain("'apps/cms/scripts/**'")
    expect(workflow).toContain("'.github/workflows/restore-drill.yml'")
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\./)
    expect(workflow).toMatch(/timeout-minutes:\s*(1[0-9]|20|2[0-5])\b/)
  })
})

describe('payload run scripts', () => {
  // `payload run <file>` exits when the module finishes evaluating: every script it runs must await its work at the top level.
  it('every script started by `payload run` awaits its main function at the top level', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../../package.json'), 'utf8')) as { scripts: Record<string, string> }
    const files = Object.values(pkg.scripts)
      .map((s) => /^payload run (\S+\.ts)/.exec(s)?.[1])
      .filter((f): f is string => Boolean(f))
    expect(files.length).toBeGreaterThan(5)
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(here, '../..', f), 'utf8')
      expect(src, `${f} must not start work with a bare main().then(...)`).not.toMatch(/^main\(\)\.then\(/m)
    }
  })
})
