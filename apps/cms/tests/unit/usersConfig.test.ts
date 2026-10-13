import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

const load = async () => (await import('../../src/collections/Users')).Users

describe('Users auth configuration', () => {
  it('uses server-side sessions, lockout, a short token lifetime and a 1 hour reset link', async () => {
    const auth = (await load()).auth as Record<string, any>
    expect(auth.useSessions).toBe(true)
    expect(auth.maxLoginAttempts).toBe(5)
    expect(auth.lockTime).toBe(600_000)
    expect(auth.tokenExpiration).toBeLessThanOrEqual(8 * 3600)
    expect(auth.forgotPassword.expiration).toBe(3_600_000)
  }, 30_000) // first import of the Users module loads Payload; slow on a cold, busy machine

  it('production cookies are Secure, SameSite=Lax and host-only', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const cookies = ((await load()).auth as Record<string, any>).cookies
    expect(cookies).toMatchObject({ secure: true, sameSite: 'Lax' })
    expect(cookies.domain).toBeUndefined()
  })

  it('non-production cookies are not Secure (plain-http localhost) but keep SameSite=Lax', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(((await load()).auth as Record<string, any>).cookies).toMatchObject({ secure: false, sameSite: 'Lax' })
  })

  it("does not use Payload's default unlock access (any logged-in user)", async () => {
    const users = await load()
    expect(typeof users.access?.unlock).toBe('function')
    const asRole = (role: string | null) => ({ req: { user: role ? { role } : null } }) as never
    expect(await users.access!.unlock!(asRole('reporter'))).toBe(false)
    expect(await users.access!.unlock!(asRole('editor-in-chief'))).toBe(false)
    expect(await users.access!.unlock!(asRole(null))).toBe(false)
    expect(await users.access!.unlock!(asRole('admin'))).toBe(true)
  })

  it('reset e-mail links to /admin/reset/<token> on CMS_PUBLIC_URL and escapes HTML', async () => {
    vi.stubEnv('CMS_PUBLIC_URL', 'https://cms.example.org/')
    const auth = (await load()).auth as Record<string, any>
    const req = { payload: { config: { serverURL: '' } } }
    const html: string = await auth.forgotPassword.generateEmailHTML({
      req,
      token: 'abc123',
      user: { name: '<img src=x onerror=alert(1)>' },
    })
    expect(html).toContain('https://cms.example.org/admin/reset/abc123')
    expect(html).not.toContain('<img')
    expect(await auth.forgotPassword.generateEmailSubject()).toMatch(/password/i)
  })
})
