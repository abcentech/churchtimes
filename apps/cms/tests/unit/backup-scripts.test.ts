/**
 * Tests for scripts/backup.sh, restore.sh and verify-backup.sh.
 *
 * The database tests need a PostgreSQL server (TEST_DATABASE_URL, as in CI) plus the client tools
 * (sh, psql, pg_dump, pg_restore). When any of them is missing the database tests are SKIPPED, and a
 * visible warning says why. They only create and drop their own randomly named databases.
 * Tests that need gpg, a non-root user or symlinks skip themselves visibly when unavailable.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts')
const has = (tool: string): boolean =>
  spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0
const hasSh = spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
const toolsOk = hasSh && has('psql') && has('pg_dump') && has('pg_restore')
const adminUrl = process.env.TEST_DATABASE_URL
const dbReady = toolsOk && Boolean(adminUrl)
const hasGpg = has('gpg')
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const canRestrictDirs = process.platform !== 'win32' && !isRoot

if (!dbReady) {
  const why = !hasSh
    ? 'sh is not available'
    : !toolsOk
      ? 'psql/pg_dump/pg_restore are not installed'
      : 'TEST_DATABASE_URL is not set'
  console.warn(`\n[backup-scripts] SKIPPING database round-trip tests: ${why}.\n`)
}
if (dbReady && !hasGpg) console.warn('\n[backup-scripts] SKIPPING encrypted/signed round trip: gpg is not installed.\n')
if (dbReady && !canRestrictDirs) {
  console.warn('\n[backup-scripts] SKIPPING unreadable-directory test: needs a non-root POSIX user.\n')
}

const run = (script: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync('sh', [path.join(scripts, script), ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

/** Rewrite SHA256SUMS of a backup directory so only deliberate corruption can fail a later check. */
const resum = (dir: string, exclude: string[] = []) => {
  const names = fs
    .readdirSync(dir)
    .filter((n) => !['SHA256SUMS', 'SHA256SUMS.sig'].includes(n) && !exclude.includes(n))
  const r = spawnSync('sha256sum', names, { cwd: dir, encoding: 'utf8' })
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), r.stdout.replace(/ \*/g, '  '))
}

describe.skipIf(!hasSh)('argument validation (no database needed)', () => {
  it('backup.sh requires --out', () => {
    const r = run('backup.sh', [], { BACKUP_DIR: '' })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('--out')
  })
  it('backup.sh rejects --keep-days 0 and junk', () => {
    expect(run('backup.sh', ['--out', 'x', '--keep-days', '0']).code).not.toBe(0)
    expect(run('backup.sh', ['--out', 'x', '--keep-days', 'abc']).code).not.toBe(0)
    expect(run('backup.sh', ['--out', 'x', '--keep-min', 'abc']).code).not.toBe(0)
  })
  it('backup.sh rejects an unknown encryption mode, signing mode and unknown flags', () => {
    expect(run('backup.sh', ['--out', 'x', '--encrypt', 'rot13']).code).not.toBe(0)
    expect(run('backup.sh', ['--out', 'x', '--sign', 'rot13']).code).not.toBe(0)
    expect(run('backup.sh', ['--bogus']).code).not.toBe(0)
  })
  it('restore.sh requires --backup; verify-backup.sh requires --backup', () => {
    expect(run('restore.sh', []).code).not.toBe(0)
    expect(run('verify-backup.sh', []).code).not.toBe(0)
  })
})

describe.skipIf(!dbReady)('backup, restore and verify round trip', () => {
  const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`
  const src = `ct_bk_src_${suffix}`
  const created: string[] = [src]
  let root = ''
  let media = ''
  let outDir = ''
  let tmpBase = ''
  let env: Record<string, string> = {}
  let backupDir = ''

  const psql = (db: string, sql: string) =>
    spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    })
  const count = (db: string, table: string) => Number(psql(db, `select count(*) from ${table}`).stdout.trim())
  const backup = (extra: string[] = [], extraEnv: Record<string, string> = {}, out = outDir) =>
    run('backup.sh', ['--out', out, '--media', media, '--tmpdir', tmpBase, ...extra], { ...env, ...extraEnv })
  const newDb = (name: string) => {
    created.push(name)
    return name
  }
  const copyBackup = (name: string) => {
    const d = path.join(root, name)
    fs.cpSync(backupDir, d, { recursive: true })
    return d
  }

  beforeAll(() => {
    const u = new URL(adminUrl as string)
    env = {
      PGHOST: u.hostname,
      PGPORT: u.port || '5432',
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGMAINT_DB: u.pathname.slice(1),
      PGDATABASE: src,
      AGE_RECIPIENT: '',
      GPG_RECIPIENT: '',
    }
    expect(psql(env.PGMAINT_DB as string, `create database ${src} encoding 'UTF8' template template0`).status).toBe(0)
    const seed = `
      create table articles(id serial primary key, title text);
      create table media(id serial primary key, filename text);
      create table legacy_comments(id serial primary key, body text);
      insert into articles(title) select 'Article ' || g from generate_series(1,7) g;
      insert into media(filename) values ('a.png'),('b.png');
      insert into legacy_comments(body) values ('Lagos 🙏 thanks'),('Ẹ ṣé');`
    expect(psql(src, seed).status).toBe(0)

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-backup-test-'))
    media = path.join(root, 'media')
    outDir = path.join(root, 'backups')
    tmpBase = path.join(root, 'tmp')
    fs.mkdirSync(tmpBase)
    fs.mkdirSync(path.join(media, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(media, 'a.png'), 'fake image a')
    fs.writeFileSync(path.join(media, 'sub', 'b file.png'), 'fake image b')
  })

  afterAll(() => {
    for (const db of created) psql(env.PGMAINT_DB as string, `drop database if exists ${db}`)
    if (root) {
      spawnSync('chmod', ['-R', 'u+rwx', root])
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('backup.sh writes a checksummed, private backup, logs no password, leaves no scratch files', () => {
    const r = backup()
    expect(r.code, r.err).toBe(0)
    backupDir = r.out.trim()
    expect(path.dirname(backupDir)).toBe(outDir)
    for (const f of ['db.dump', 'media.tar.gz', 'media.manifest.sha256', 'counts.txt', 'SHA256SUMS']) {
      expect(fs.existsSync(path.join(backupDir, f)), f).toBe(true)
    }
    expect(fs.readFileSync(path.join(backupDir, 'counts.txt'), 'utf8')).toContain('articles 7 7')
    expect(fs.readFileSync(path.join(backupDir, 'media.manifest.sha256'), 'utf8')).toContain('  ./sub/b file.png')
    if (process.platform !== 'win32') {
      expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700)
      expect(fs.statSync(path.join(backupDir, 'db.dump')).mode & 0o777).toBe(0o600)
    }
    if (env.PGPASSWORD) expect(r.err + r.out).not.toContain(env.PGPASSWORD)
    // M2: nothing but finished backups in the (synced) output directory; scratch space is elsewhere and clean.
    expect(fs.readdirSync(outDir).filter((n) => !n.startsWith('churchtimes-'))).toEqual([])
    expect(fs.readdirSync(tmpBase)).toEqual([])
  })

  it('refuses a backup directory inside a git checkout', () => {
    const inside = path.join(scripts, '..', 'tmp-backups')
    const r = backup([], {}, inside)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('inside the git checkout')
    fs.rmSync(inside, { recursive: true, force: true })
  })

  it('--encrypt age or auto fails without a recipient, and auto needs --allow-plaintext to go plain', () => {
    expect(backup(['--encrypt', 'age']).code).not.toBe(0)
    const auto = backup(['--encrypt', 'auto'])
    expect(auto.code).not.toBe(0)
    expect(auto.err).toContain('--allow-plaintext')
    expect(fs.readdirSync(outDir).filter((n) => n.startsWith('churchtimes-'))).toHaveLength(1)
  })

  it('removes stale .partial-* and .tmp-* debris but never touches other directories', () => {
    const stale = [path.join(outDir, '.partial-old'), path.join(outDir, '.tmp-old')]
    const fresh = path.join(outDir, '.partial-fresh')
    for (const d of [...stale, fresh]) fs.mkdirSync(d)
    const past = new Date(Date.now() - 3 * 86400_000)
    for (const d of stale) fs.utimesSync(d, past, past)
    const r = backup(['--keep-days', '30', '--keep-min', '5'])
    expect(r.code, r.err).toBe(0)
    for (const d of stale) expect(fs.existsSync(d), d).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
    fs.rmSync(fresh, { recursive: true })
  })

  it('restore.sh restores into a NEW database with matching counts and media', () => {
    const target = newDb(`ct_bk_new_${suffix}`)
    const mediaOut = path.join(root, 'media-restored')
    const r = run('restore.sh', ['--backup', backupDir, '--target-db', target, '--media-target', mediaOut, '--tmpdir', tmpBase], env)
    expect(r.code, r.err).toBe(0)
    expect(count(target, 'articles')).toBe(7)
    expect(count(target, 'media')).toBe(2)
    expect(psql(target, 'select body from legacy_comments order by id limit 1').stdout.trim()).toBe('Lagos 🙏 thanks')
    expect(fs.readFileSync(path.join(mediaOut, 'sub', 'b file.png'), 'utf8')).toBe('fake image b')
    expect(fs.existsSync(path.join(mediaOut, '.manifest.sha256'))).toBe(false)
    expect(fs.readdirSync(tmpBase)).toEqual([])
  })

  it('container mode (PG_EXEC prefix, data over stdin/stdout) round-trips', () => {
    // `env` as the prefix exercises the same stdin/stdout plumbing a `docker compose exec -T` prefix uses.
    const r = backup(['--pg-exec', 'env'])
    expect(r.code, r.err).toBe(0)
    const dir = r.out.trim()
    const target = newDb(`ct_bk_ctr_${suffix}`)
    const ok = run('restore.sh', ['--backup', dir, '--target-db', target, '--skip-media', '--pg-exec', 'env', '--tmpdir', tmpBase], env)
    expect(ok.code, ok.err).toBe(0)
    expect(count(target, 'articles')).toBe(7)
    const v = run('verify-backup.sh', ['--backup', dir, '--pg-exec', 'env', '--tmpdir', tmpBase], env)
    expect(v.code, v.err).toBe(0)
  })

  it('restore.sh refuses a non-empty database unless --overwrite-db is given', () => {
    const r = run('restore.sh', ['--backup', backupDir, '--target-db', src, '--tmpdir', tmpBase], env)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('refusing')
    expect(count(src, 'articles')).toBe(7)
    const ok = run('restore.sh', ['--backup', backupDir, '--target-db', src, '--overwrite-db', '--skip-media', '--tmpdir', tmpBase], env)
    expect(ok.code, ok.err).toBe(0)
    expect(count(src, 'articles')).toBe(7)
  })

  it('restore.sh refuses a non-empty media directory', () => {
    const r = run('restore.sh', ['--backup', backupDir, '--target-db', `ct_bk_m_${suffix}`, '--media-target', media, '--tmpdir', tmpBase], env)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('not empty')
  })

  it('verify-backup.sh passes on a good backup and drops its throwaway database', () => {
    const r = run('verify-backup.sh', ['--backup', backupDir, '--tmpdir', tmpBase], env)
    expect(r.code, r.err).toBe(0)
    expect(r.err).toContain('VERIFIED')
    const left = psql(env.PGMAINT_DB as string, "select count(*) from pg_database where datname like 'churchtimes_verify_%'")
    expect(left.stdout.trim()).toBe('0')
    expect(fs.readdirSync(tmpBase)).toEqual([])
  })

  it('detects a corrupted dump and a tampered media archive via checksums', () => {
    for (const file of ['db.dump', 'media.tar.gz']) {
      const bad = copyBackup(`bad-${file}`)
      fs.appendFileSync(path.join(bad, file), 'x')
      const r = run('verify-backup.sh', ['--backup', bad, '--tmpdir', tmpBase], env)
      expect(r.code, file).not.toBe(0)
      expect(r.err).toContain('checksum verification FAILED')
    }
  })

  it('M3: refuses a stray unlisted artifact, including a plaintext dump next to a listed encrypted one', () => {
    const stray = copyBackup('bad-stray')
    fs.copyFileSync(path.join(stray, 'db.dump'), path.join(stray, 'db.dump.age'))
    const r = run('restore.sh', ['--backup', stray, '--target-db', `ct_bk_s_${suffix}`, '--tmpdir', tmpBase], env)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('unlisted')

    // SHA256SUMS lists only db.dump.age while a plaintext db.dump sits beside it.
    const swapped = copyBackup('bad-swapped')
    fs.copyFileSync(path.join(swapped, 'db.dump'), path.join(swapped, 'db.dump.age'))
    resum(swapped, ['db.dump'])
    const s = run('restore.sh', ['--backup', swapped, '--target-db', `ct_bk_s2_${suffix}`, '--tmpdir', tmpBase], env)
    expect(s.code).not.toBe(0)
    expect(s.err).toContain('unlisted')
    const missing = copyBackup('bad-missing')
    resum(missing, ['counts.txt'])
    fs.rmSync(path.join(missing, 'counts.txt'))
    expect(run('restore.sh', ['--backup', missing, '--target-db', `ct_bk_s3_${suffix}`, '--tmpdir', tmpBase], env).code).not.toBe(0)
  })

  it('detects row-count drift, and refuses an unsafe table name in counts.txt', () => {
    const bad = copyBackup('bad-counts')
    fs.writeFileSync(path.join(bad, 'counts.txt'), '# t\narticles 99 99\n')
    resum(bad)
    const r = run('verify-backup.sh', ['--backup', bad, '--tmpdir', tmpBase], env)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('MISMATCH')

    const inj = copyBackup('bad-inject')
    fs.writeFileSync(path.join(inj, 'counts.txt'), '# t\narticles;drop 1 1\n')
    resum(inj)
    const i = run('verify-backup.sh', ['--backup', inj, '--tmpdir', tmpBase], env)
    expect(i.code).not.toBe(0)
    expect(i.err).toContain('invalid table name')
  })

  it('media manifest mismatch fails verification, but --skip-media still restores the database', () => {
    const bad = copyBackup('bad-manifest')
    const x = path.join(root, 'bad-manifest-x')
    fs.mkdirSync(x)
    spawnSync('tar', ['-xzf', path.join(bad, 'media.tar.gz'), '-C', x])
    fs.writeFileSync(path.join(x, 'a.png'), 'TAMPERED')
    spawnSync('tar', ['-czf', path.join(bad, 'media.tar.gz'), '-C', x, '.'])
    resum(bad)
    const r = run('verify-backup.sh', ['--backup', bad, '--tmpdir', tmpBase], env)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('media manifest verification FAILED')
    const target = newDb(`ct_bk_skip_${suffix}`)
    const ok = run('restore.sh', ['--backup', bad, '--target-db', target, '--skip-media', '--tmpdir', tmpBase], env)
    expect(ok.code, ok.err).toBe(0)
    expect(count(target, 'articles')).toBe(7)
  })

  it('M4: fails when the media folder is empty (unless allowed), contains symlinks, or has an unreadable directory', () => {
    const emptyMedia = path.join(root, 'media-empty')
    fs.mkdirSync(emptyMedia)
    const e = run('backup.sh', ['--out', path.join(root, 'o-empty'), '--media', emptyMedia, '--tmpdir', tmpBase], env)
    expect(e.code).not.toBe(0)
    expect(e.err).toContain('--allow-empty-media')
    const allowed = run('backup.sh', ['--out', path.join(root, 'o-empty'), '--media', emptyMedia, '--allow-empty-media', '--tmpdir', tmpBase], env)
    expect(allowed.code, allowed.err).toBe(0)

    const linkMedia = path.join(root, 'media-link')
    fs.mkdirSync(linkMedia)
    fs.writeFileSync(path.join(linkMedia, 'real.png'), 'x')
    let linked = true
    try {
      fs.symlinkSync(path.join(linkMedia, 'real.png'), path.join(linkMedia, 'link.png'))
    } catch {
      linked = false
      console.warn('[backup-scripts] SKIPPING symlink check: cannot create symlinks here.')
    }
    if (linked) {
      const l = run('backup.sh', ['--out', path.join(root, 'o-link'), '--media', linkMedia, '--tmpdir', tmpBase], env)
      expect(l.code).not.toBe(0)
      expect(l.err).toContain('symlinks')
      expect(fs.readdirSync(path.join(root, 'o-link'))).toEqual([])
    }

    if (canRestrictDirs) {
      const priv = path.join(media, 'private')
      fs.mkdirSync(priv)
      fs.writeFileSync(path.join(priv, 'secret.png'), 'hidden')
      fs.chmodSync(priv, 0o000)
      try {
        const u = backup([], {}, path.join(root, 'o-unreadable'))
        expect(u.code).not.toBe(0)
        expect(fs.readdirSync(path.join(root, 'o-unreadable'))).toEqual([])
      } finally {
        fs.chmodSync(priv, 0o755)
        fs.rmSync(priv, { recursive: true, force: true })
      }
    }
  })

  it('a failing or empty pg_dump fails the backup and leaves nothing behind', () => {
    for (const [name, body] of [
      ['fails', 'exit 3'],
      ['empty', 'exit 0'],
    ] as const) {
      const shim = path.join(root, `shim-${name}`)
      fs.mkdirSync(shim)
      fs.writeFileSync(path.join(shim, 'pg_dump'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
      const out = path.join(root, `o-${name}`)
      const r = backup([], { PATH: `${shim}${path.delimiter}${process.env.PATH}` }, out)
      expect(r.code, name).not.toBe(0)
      expect(fs.readdirSync(out), name).toEqual([])
    }
  })

  it('--keep-days prunes only old backup directories, and always keeps the newest --keep-min', () => {
    const old = path.join(outDir, 'churchtimes-20200101T000000Z')
    const other = path.join(outDir, 'keep-me')
    fs.mkdirSync(old)
    fs.mkdirSync(other)
    const past = new Date(Date.now() - 400 * 86400_000)
    fs.utimesSync(old, past, past)
    fs.utimesSync(other, past, past)
    const r = backup(['--keep-days', '30', '--keep-min', '1'])
    expect(r.code, r.err).toBe(0)
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(other)).toBe(true)

    const out2 = path.join(root, 'o-min')
    fs.mkdirSync(out2)
    const olds = ['20200101', '20200102', '20200103'].map((d) => path.join(out2, `churchtimes-${d}T000000Z`))
    for (const d of olds) {
      fs.mkdirSync(d)
      fs.utimesSync(d, past, past)
    }
    const m = backup(['--keep-days', '30'], {}, out2)
    expect(m.code, m.err).toBe(0)
    expect(olds.map((d) => fs.existsSync(d))).toEqual([false, true, true])
  })

  it.skipIf(!hasGpg)('encrypted and signed round trip with gpg; a bad signature is refused', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-gnupg-'))
    fs.chmodSync(home, 0o700)
    const gpgEnv = { ...env, GNUPGHOME: home }
    const gen = spawnSync(
      'gpg',
      ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'ct-backup-test@example.invalid', 'default', 'default', 'never'],
      { env: { ...process.env, ...gpgEnv }, encoding: 'utf8' },
    )
    expect(gen.status, gen.stderr).toBe(0)
    const list = spawnSync('gpg', ['--with-colons', '--list-keys'], { env: { ...process.env, ...gpgEnv }, encoding: 'utf8' })
    const fpr = (list.stdout.split('\n').find((l) => l.startsWith('fpr:')) ?? '').split(':')[9]
    expect(fpr).toBeTruthy()
    const keyEnv = { ...gpgEnv, GPG_RECIPIENT: fpr as string, GPG_SIGN_KEY: fpr as string }
    try {
      const out = path.join(root, 'o-gpg')
      const r = backup(['--encrypt', 'auto', '--sign', 'gpg'], keyEnv, out)
      expect(r.code, r.err).toBe(0)
      const dir = r.out.trim()
      const names = fs.readdirSync(dir)
      expect(names).toContain('db.dump.gpg')
      expect(names).not.toContain('db.dump')
      expect(names).toContain('SHA256SUMS.sig')
      expect(fs.readFileSync(path.join(dir, 'db.dump.gpg')).includes('PGDMP')).toBe(false)

      const ok = run('verify-backup.sh', ['--backup', dir, '--verify-sig', 'gpg', '--tmpdir', tmpBase], keyEnv)
      expect(ok.code, ok.err).toBe(0)

      // A plaintext dump dropped next to the encrypted one is refused (not listed in SHA256SUMS).
      const stray = path.join(root, 'o-gpg-stray')
      fs.cpSync(dir, stray, { recursive: true })
      fs.writeFileSync(path.join(stray, 'db.dump'), 'PGDMPfake')
      const s = run('restore.sh', ['--backup', stray, '--target-db', `ct_bk_g_${suffix}`, '--tmpdir', tmpBase], keyEnv)
      expect(s.code).not.toBe(0)
      expect(s.err).toContain('unlisted')

      // Tampered signature.
      const bad = path.join(root, 'o-gpg-badsig')
      fs.cpSync(dir, bad, { recursive: true })
      const sig = fs.readFileSync(path.join(bad, 'SHA256SUMS.sig'))
      sig[sig.length - 8] ^= 0xff
      fs.writeFileSync(path.join(bad, 'SHA256SUMS.sig'), sig)
      const b = run('verify-backup.sh', ['--backup', bad, '--verify-sig', 'gpg', '--tmpdir', tmpBase], keyEnv)
      expect(b.code).not.toBe(0)
      expect(b.err).toContain('signature')
    } finally {
      spawnSync('gpgconf', ['--kill', 'all'], { env: { ...process.env, ...gpgEnv } })
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
