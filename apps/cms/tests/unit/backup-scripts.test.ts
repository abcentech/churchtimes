/**
 * Tests for scripts/backup.sh, restore.sh and verify-backup.sh.
 *
 * The database tests need a PostgreSQL server (TEST_DATABASE_URL, as in CI) plus the client tools
 * (sh, psql, pg_dump, pg_restore). When any of them is missing the database tests are SKIPPED, and a
 * visible warning says why. They only create and drop their own randomly named databases.
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

if (!dbReady) {
  const why = !hasSh
    ? 'sh is not available'
    : !toolsOk
      ? 'psql/pg_dump/pg_restore are not installed'
      : 'TEST_DATABASE_URL is not set'
  console.warn(`\n[backup-scripts] SKIPPING database round-trip tests: ${why}.\n`)
}

const run = (script: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync('sh', [path.join(scripts, script), ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
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
  })
  it('backup.sh rejects an unknown encryption mode and unknown flags', () => {
    expect(run('backup.sh', ['--out', 'x', '--encrypt', 'rot13']).code).not.toBe(0)
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
  let env: Record<string, string> = {}
  let backupDir = ''

  const psql = (db: string, sql: string) =>
    spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    })
  const count = (db: string, table: string) => Number(psql(db, `select count(*) from ${table}`).stdout.trim())

  beforeAll(() => {
    const u = new URL(adminUrl as string)
    env = {
      PGHOST: u.hostname,
      PGPORT: u.port || '5432',
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGMAINT_DB: u.pathname.slice(1),
      PGDATABASE: src,
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
    fs.mkdirSync(path.join(media, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(media, 'a.png'), 'fake image a')
    fs.writeFileSync(path.join(media, 'sub', 'b file.png'), 'fake image b')
  })

  afterAll(() => {
    for (const db of created) psql(env.PGMAINT_DB as string, `drop database if exists ${db}`)
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  it('backup.sh writes a checksummed, private backup and logs no password', () => {
    const r = run('backup.sh', ['--out', outDir, '--media', media], env)
    expect(r.code, r.err).toBe(0)
    backupDir = r.out.trim()
    expect(path.dirname(backupDir)).toBe(outDir)
    for (const f of ['db.dump', 'media.tar.gz', 'media.manifest.sha256', 'counts.txt', 'SHA256SUMS']) {
      expect(fs.existsSync(path.join(backupDir, f)), f).toBe(true)
    }
    expect(fs.readFileSync(path.join(backupDir, 'counts.txt'), 'utf8')).toContain('articles 7 7')
    expect(fs.readFileSync(path.join(backupDir, 'media.manifest.sha256'), 'utf8')).toContain('  sub/b file.png')
    if (process.platform !== 'win32') {
      expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700)
      expect(fs.statSync(path.join(backupDir, 'db.dump')).mode & 0o777).toBe(0o600)
    }
    if (env.PGPASSWORD) expect(r.err + r.out).not.toContain(env.PGPASSWORD)
  })

  it('refuses a backup directory inside a git checkout', () => {
    const r = run('backup.sh', ['--out', path.join(scripts, '..', 'tmp-backups'), '--media', media], env)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('inside the git checkout')
    expect(fs.existsSync(path.join(scripts, '..', 'tmp-backups', 'churchtimes-x'))).toBe(false)
    fs.rmSync(path.join(scripts, '..', 'tmp-backups'), { recursive: true, force: true })
  })

  it('fails when encryption is requested but no recipient is configured', () => {
    const r = run('backup.sh', ['--out', outDir, '--media', media, '--encrypt', 'age'], { ...env, AGE_RECIPIENT: '' })
    expect(r.code).not.toBe(0)
    expect(fs.readdirSync(outDir).filter((n) => n.startsWith('churchtimes-'))).toHaveLength(1)
  })

  it('restore.sh restores into a NEW database with matching counts and media', () => {
    const target = `ct_bk_new_${suffix}`
    created.push(target)
    const mediaOut = path.join(root, 'media-restored')
    const r = run('restore.sh', ['--backup', backupDir, '--target-db', target, '--media-target', mediaOut], env)
    expect(r.code, r.err).toBe(0)
    expect(count(target, 'articles')).toBe(7)
    expect(count(target, 'media')).toBe(2)
    expect(psql(target, 'select body from legacy_comments order by id limit 1').stdout.trim()).toBe('Lagos 🙏 thanks')
    expect(fs.readFileSync(path.join(mediaOut, 'sub', 'b file.png'), 'utf8')).toBe('fake image b')
    expect(fs.existsSync(path.join(mediaOut, '.manifest.sha256'))).toBe(false)
  })

  it('restore.sh refuses a non-empty database unless --overwrite-db is given', () => {
    const r = run('restore.sh', ['--backup', backupDir, '--target-db', src], env)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('refusing')
    expect(count(src, 'articles')).toBe(7)
    const ok = run('restore.sh', ['--backup', backupDir, '--target-db', src, '--overwrite-db'], env)
    expect(ok.code, ok.err).toBe(0)
    expect(count(src, 'articles')).toBe(7)
  })

  it('restore.sh refuses a non-empty media directory', () => {
    const r = run('restore.sh', ['--backup', backupDir, '--target-db', `ct_bk_m_${suffix}`, '--media-target', media], env)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('not empty')
  })

  it('verify-backup.sh passes on a good backup and drops its throwaway database', () => {
    const r = run('verify-backup.sh', ['--backup', backupDir], env)
    expect(r.code, r.err).toBe(0)
    expect(r.err).toContain('VERIFIED')
    const left = psql(env.PGMAINT_DB as string, "select count(*) from pg_database where datname like 'churchtimes_verify_%'")
    expect(left.stdout.trim()).toBe('0')
  })

  it('detects a corrupted dump and a tampered media archive via checksums', () => {
    for (const file of ['db.dump', 'media.tar.gz']) {
      const bad = path.join(root, `bad-${file}`)
      fs.cpSync(backupDir, bad, { recursive: true })
      fs.appendFileSync(path.join(bad, file), 'x')
      const r = run('verify-backup.sh', ['--backup', bad], env)
      expect(r.code, file).not.toBe(0)
      expect(r.err).toContain('checksum verification FAILED')
    }
  })

  it('detects row-count drift between backup and restore', () => {
    const bad = path.join(root, 'bad-counts')
    fs.cpSync(backupDir, bad, { recursive: true })
    fs.writeFileSync(path.join(bad, 'counts.txt'), '# t\narticles 99 99\n')
    // Keep SHA256SUMS honest so only the count check can fail.
    const sums = fs
      .readFileSync(path.join(bad, 'SHA256SUMS'), 'utf8')
      .split('\n')
      .filter((l) => l && !l.endsWith('  counts.txt'))
    const sha = spawnSync('sh', ['-c', `cd "${bad.replace(/\\/g, '/')}" && sha256sum counts.txt`], { encoding: 'utf8' }).stdout.trim()
    fs.writeFileSync(path.join(bad, 'SHA256SUMS'), [...sums, sha].join('\n') + '\n')
    const r = run('verify-backup.sh', ['--backup', bad], env)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('MISMATCH')
  })

  it('--keep-days prunes only old backup directories', () => {
    const old = path.join(outDir, 'churchtimes-20200101T000000Z')
    const other = path.join(outDir, 'keep-me')
    fs.mkdirSync(old)
    fs.mkdirSync(other)
    const past = new Date(Date.now() - 400 * 86400_000)
    fs.utimesSync(old, past, past)
    fs.utimesSync(other, past, past)
    const r = run('backup.sh', ['--out', outDir, '--media', media, '--keep-days', '30'], env)
    expect(r.code, r.err).toBe(0)
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(other)).toBe(true)
    expect(fs.existsSync(backupDir)).toBe(true)
  })
})
