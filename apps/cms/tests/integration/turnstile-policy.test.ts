/**
 * Turnstile hostname and action policy at the endpoint level (POST /api/public/submissions).
 *
 * tests/unit/turnstile.test.ts covers verifyTurnstile in isolation. Here the real route decides the
 * status code and whether anything is stored or receipted. Only the Siteverify transport is replaced,
 * with a stub that answers per token, so each case can claim a different hostname or action.
 *
 * TURNSTILE_ALLOWED_HOSTNAMES and TURNSTILE_EXPECTED_ACTION are read from process.env on every request
 * (verifyTurnstile is called without an env override), so each describe block sets them and the
 * original values are restored afterwards. Other test files never see these settings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { setTurnstileFetchForTests } from '../../src/lib/turnstile'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

const runId = newRunId()
let f: Fixtures

/** Canned Siteverify answers, keyed by the token the form sends. */
const ANSWERS: Record<string, Record<string, unknown>> = {
  'tok-good': { success: true, hostname: 'allowed.test', action: 'submit-story' },
  'tok-good-mixed-case-host': { success: true, hostname: 'Allowed.TEST', action: 'submit-story' },
  'tok-second-listed-action': { success: true, hostname: 'allowed.test', action: 'public_story' },
  'tok-wrong-hostname': { success: true, hostname: 'evil.test', action: 'submit-story' },
  'tok-no-hostname': { success: true, action: 'submit-story' },
  'tok-wrong-action': { success: true, hostname: 'allowed.test', action: 'submit-contact' },
  'tok-no-action': { success: true, hostname: 'allowed.test' },
}
const siteverifiedTokens: string[] = []

const POLICY_KEYS = ['TURNSTILE_ALLOWED_HOSTNAMES', 'TURNSTILE_EXPECTED_ACTION'] as const
const savedPolicy: Record<string, string | undefined> = {}

/** Set (or, for undefined, unset) the policy variables for the current describe block. */
function setPolicy(policy: { hostnames?: string; action?: string }): void {
  const values = { TURNSTILE_ALLOWED_HOSTNAMES: policy.hostnames, TURNSTILE_EXPECTED_ACTION: policy.action }
  for (const key of POLICY_KEYS) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

beforeAll(async () => {
  for (const key of POLICY_KEYS) savedPolicy[key] = process.env[key]
  setTurnstileFetchForTests(async (_url, init) => {
    const response = new URLSearchParams(String(init.body)).get('response') ?? ''
    siteverifiedTokens.push(response)
    const answer = ANSWERS[response] ?? { success: false, 'error-codes': ['invalid-input-response'] }
    return Response.json(answer)
  })
  f = await setupFixtures(runId)
})

afterAll(async () => {
  setTurnstileFetchForTests(undefined)
  for (const key of POLICY_KEYS) {
    if (savedPolicy[key] === undefined) delete process.env[key]
    else process.env[key] = savedPolicy[key]
  }
  await f?.cleanup()
})

let ipN = 0
// Random third-octet base so repeated runs never share a rate-limit bucket if the limiter is ever persisted.
const ipBase = Math.floor(Math.random() * 200)
const nextIp = () => `198.19.${ipBase + Math.floor(ipN / 250)}.${((ipN += 1) % 250) + 1}`

let n = 0
const story = (token: string) => {
  n += 1
  return {
    name: 'Ada Obi',
    email: `policy.${runId}.${n}@example.com`,
    title: `${runId} policy story ${n}`,
    body: 'The church opened a free clinic in Ibadan this week for residents of the district.',
    turnstileToken: token,
  }
}

const submit = (body: unknown) =>
  api('POST', '/api/public/submissions', {
    body,
    headers: { 'x-forwarded-for': nextIp(), 'user-agent': 'vitest' },
  })

const storedByTitle = async (title: string) =>
  (
    await f.payload.find({
      collection: 'submissions',
      where: { title: { equals: title } },
      limit: 5,
      depth: 0,
      overrideAccess: true,
    })
  ).docs as Array<Record<string, any>>

const REJECTED = {
  ok: false,
  errors: [{ field: 'turnstileToken', message: 'Verification failed. Please try again.' }],
}

describe('Turnstile policy enforced at the endpoint (TURNSTILE_ALLOWED_HOSTNAMES + TURNSTILE_EXPECTED_ACTION set)', () => {
  beforeAll(() => setPolicy({ hostnames: 'allowed.test', action: 'submit-story,public_story' }))

  it('wrong hostname -> 403 generic rejection, nothing stored, no receipt', async () => {
    const body = story('tok-wrong-hostname')
    const res = await submit(body)
    expect(res.status).toBe(403)
    expect(res.json).toEqual(REJECTED)
    expect(res.json.reference).toBeUndefined()
    expect(siteverifiedTokens).toContain('tok-wrong-hostname') // the rejection came from the policy, not the transport
    expect(await storedByTitle(body.title)).toHaveLength(0)
  })

  it('no hostname in the Siteverify answer while an allowlist is set -> 403, nothing stored', async () => {
    const body = story('tok-no-hostname')
    const res = await submit(body)
    expect(res.status).toBe(403)
    expect(res.json).toEqual(REJECTED)
    expect(await storedByTitle(body.title)).toHaveLength(0)
  })

  it('wrong action -> 403 generic rejection, nothing stored, no receipt', async () => {
    const body = story('tok-wrong-action')
    const res = await submit(body)
    expect(res.status).toBe(403)
    expect(res.json).toEqual(REJECTED)
    expect(res.json.reference).toBeUndefined()
    expect(await storedByTitle(body.title)).toHaveLength(0)
  })

  it('action missing from the answer while an action is expected -> 403, nothing stored', async () => {
    const body = story('tok-no-action')
    const res = await submit(body)
    expect(res.status).toBe(403)
    expect(res.json).toEqual(REJECTED)
    expect(await storedByTitle(body.title)).toHaveLength(0)
  })

  it('correct hostname and action -> 201 with a receipt, stored once', async () => {
    const body = story('tok-good')
    const res = await submit(body)
    expect(res.status).toBe(201)
    expect(res.json.ok).toBe(true)
    expect(typeof res.json.reference).toBe('string')
    expect(await storedByTitle(body.title)).toHaveLength(1)
  })

  it('hostname comparison is case-insensitive; any listed action is accepted', async () => {
    const mixedCase = story('tok-good-mixed-case-host')
    expect((await submit(mixedCase)).status).toBe(201)
    const listed = story('tok-second-listed-action')
    expect((await submit(listed)).status).toBe(201)
    expect(await storedByTitle(listed.title)).toHaveLength(1)
  })
})

describe('Turnstile policy unset (opt-in): hostname and action are not enforced', () => {
  beforeAll(() => setPolicy({}))

  it('a valid Siteverify answer with a different hostname, action or no action is accepted', async () => {
    for (const token of ['tok-wrong-hostname', 'tok-wrong-action', 'tok-no-action', 'tok-no-hostname']) {
      const body = story(token)
      const res = await submit(body)
      expect(res.status, token).toBe(201)
      expect(await storedByTitle(body.title), token).toHaveLength(1)
    }
  })
})
