import { beforeEach, describe, expect, it, vi } from 'vitest'

const runner = {
  createDigestDraft: vi.fn(async () => ({ outcome: 'draft', issueId: 7, stories: 2 })),
  sendTestDigest: vi.fn(async () => ({ outcome: 'sent', sent: 1, stories: 1 })),
}
vi.mock('../../src/lib/newsletterDigestRunner', () => runner)

const { digestDryRunEndpoint, digestTestSendEndpoint, resetDigestStaffLimiter } = await import('../../src/endpoints/newsletterDigestStaff')

const payload = () => ({ sendEmail: vi.fn(async () => undefined), create: vi.fn(async () => ({})), logger: { error: vi.fn() } })
const req = (user: Record<string, unknown> | null, p = payload(), body = '{"to":"victim@example.org"}') =>
  ({ user, payload: p, headers: new Headers(), json: async () => JSON.parse(body), context: {} }) as never

beforeEach(() => {
  resetDigestStaffLimiter()
  process.env.SMTP_HOST = 'smtp.example.org'
  vi.clearAllMocks()
})

describe('digest staff tools', () => {
  it('require an editor or admin', async () => {
    expect((await digestDryRunEndpoint.handler(req(null))).status).toBe(401)
    expect((await digestDryRunEndpoint.handler(req({ id: 1, role: 'reporter', email: 'r@example.org' }))).status).toBe(403)
    expect((await digestTestSendEndpoint.handler(req({ id: 1, role: 'reporter', email: 'r@example.org' }))).status).toBe(403)
    expect(runner.createDigestDraft).not.toHaveBeenCalled()
  })

  it('dry run writes a draft and sends nothing', async () => {
    const p = payload()
    const res = await digestDryRunEndpoint.handler(req({ id: 2, role: 'editor-in-chief', email: 'e@example.org' }, p))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'draft', issueId: 7 })
    expect(p.sendEmail).not.toHaveBeenCalled()
  })

  it('test send goes ONLY to the signed-in staff address, never to an address in the request', async () => {
    const p = payload()
    const res = await digestTestSendEndpoint.handler(req({ id: 3, role: 'admin', email: 'staff@example.org' }, p))
    expect(res.status).toBe(200)
    expect(runner.sendTestDigest).toHaveBeenCalledTimes(1)
    expect(runner.sendTestDigest.mock.calls[0]).toEqual([p, 'staff@example.org'])
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'test-sent', stories: 1 })
  })

  it('test send is limited to 5 per hour per user and needs SMTP', async () => {
    const user = { id: 4, role: 'admin', email: 'staff@example.org' }
    for (let i = 0; i < 5; i++) expect((await digestTestSendEndpoint.handler(req(user))).status).toBe(200)
    expect((await digestTestSendEndpoint.handler(req(user))).status).toBe(429)
    delete process.env.SMTP_HOST
    expect((await digestTestSendEndpoint.handler(req({ ...user, id: 5 }))).status).toBe(503)
  })
})
