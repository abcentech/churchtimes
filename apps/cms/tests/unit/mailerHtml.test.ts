import { describe, expect, it, vi } from 'vitest'

import { escapeHtml, html, renderDocument, safeHref } from '../../src/lib/emailTemplate'
import {
  DailyMailCap,
  htmlDailyCapFromEnv,
  htmlMailHeaders,
  lagosDay,
  MailCapReachedError,
  sendHtmlMail,
  sendPlainMail,
} from '../../src/lib/mailer'

const fakePayload = () => ({ sendEmail: vi.fn(async (_m: Record<string, unknown>) => undefined) })
const doc = renderDocument(html`<p>${'Hello'}</p>`)

describe('emailTemplate', () => {
  it('escapes every interpolated string, including attribute breakers', () => {
    const evil = `"><script>alert(1)</script><img src=x onerror='y'>&`
    const out = renderDocument(html`<a title="${evil}">${evil}</a>`)
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('"><')
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('&quot;&gt;')
    expect(out).toContain('&#39;y&#39;')
    expect(out).toContain('&amp;')
  })

  it('nests fragments without double escaping, but never trusts a plain string that looks like markup', () => {
    const inner = html`<b>${'a & b'}</b>`
    expect(renderDocument(html`<p>${inner}</p>`)).toBe('<p><b>a &amp; b</b></p>')
    expect(renderDocument(html`<p>${'<b>x</b>'}</p>`)).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>')
    expect(renderDocument(html`<ul>${[html`<li>${'1'}</li>`, html`<li>${'<2>'}</li>`]}</ul>`)).toBe('<ul><li>1</li><li>&lt;2&gt;</li></ul>')
  })

  it('refuses to render anything that is not a template fragment', () => {
    expect(() => renderDocument('<p>raw</p>' as never)).toThrow('Untrusted')
    expect(() => renderDocument({ value: '<p>forged</p>' } as never)).toThrow('Untrusted')
  })

  it('only lets absolute http(s) URLs into hrefs', () => {
    expect(safeHref('javascript:alert(1)')).toBe('#')
    expect(safeHref('data:text/html,x')).toBe('#')
    expect(safeHref('/relative')).toBe('#')
    expect(safeHref('https://churchtimesnigeria.net/a-b/')).toBe('https://churchtimesnigeria.net/a-b/')
    expect(escapeHtml(safeHref('https://x.test/?a=1&b="2"'))).toBe('https://x.test/?a=1&amp;b=%222%22')
  })
})

describe('htmlMailHeaders', () => {
  it('adds RFC 2369/8058 one-click headers and List-Id', () => {
    const h = htmlMailHeaders({
      unsubscribeUrl: 'https://cms.example.org/api/public/newsletter/one-click?token=u1.5.abc',
      unsubscribeMailto: 'unsubscribe@example.org',
      listId: 'daily-digest.example.org',
    })
    expect(h['List-Unsubscribe']).toBe(
      '<https://cms.example.org/api/public/newsletter/one-click?token=u1.5.abc>, <mailto:unsubscribe@example.org?subject=unsubscribe>',
    )
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(h['List-Id']).toBe('<daily-digest.example.org>')
  })

  it('never emits header injection or non-https one-click URLs', () => {
    expect(htmlMailHeaders({})).toEqual({})
    // CR/LF are stripped first, so an injected header collapses into an invalid URL that is refused.
    expect(() => htmlMailHeaders({ unsubscribeUrl: 'https://a.test/x\r\nBcc: victim@example.org' })).toThrow('Unsafe')
    expect(() => htmlMailHeaders({ unsubscribeUrl: 'http://evil.test/x' })).toThrow('Unsafe')
    expect(() => htmlMailHeaders({ unsubscribeUrl: 'javascript:alert(1)' })).toThrow('Unsafe')
    expect(() => htmlMailHeaders({ unsubscribeUrl: 'https://a.test/>, <https://b.test/' })).toThrow('Unsafe')
    expect(() => htmlMailHeaders({ listId: 'a b>' })).toThrow('Unsafe')
    expect(htmlMailHeaders({ unsubscribeUrl: 'http://localhost:3200/api/x?token=1' })['List-Unsubscribe']).toBe(
      '<http://localhost:3200/api/x?token=1>',
    )
  })
})

describe('DailyMailCap', () => {
  it('counts per Lagos day and resets at Lagos midnight (23:00 UTC)', () => {
    const cap = new DailyMailCap(() => 2)
    const before = new Date('2026-10-30T22:59:00Z')
    expect(lagosDay(before)).toBe('2026-10-30')
    expect(cap.take(before)).toBe(true)
    expect(cap.take(before)).toBe(true)
    expect(cap.take(before)).toBe(false)
    expect(cap.remaining(before)).toBe(0)
    const after = new Date('2026-10-30T23:00:00Z')
    expect(lagosDay(after)).toBe('2026-10-31')
    expect(cap.remaining(after)).toBe(2)
    expect(cap.take(after)).toBe(true)
  })

  it('reads MAIL_HTML_DAILY_CAP strictly (default 300, 0 allowed)', () => {
    expect(htmlDailyCapFromEnv({} as NodeJS.ProcessEnv)).toBe(300)
    expect(htmlDailyCapFromEnv({ MAIL_HTML_DAILY_CAP: '0' } as never)).toBe(0)
    expect(htmlDailyCapFromEnv({ MAIL_HTML_DAILY_CAP: '25' } as never)).toBe(25)
    expect(htmlDailyCapFromEnv({ MAIL_HTML_DAILY_CAP: '-1' } as never)).toBe(300)
    expect(htmlDailyCapFromEnv({ MAIL_HTML_DAILY_CAP: '1e3' } as never)).toBe(300)
  })
})

describe('sendHtmlMail', () => {
  it('sends one multipart mail with stripped headers and the unsubscribe headers', async () => {
    process.env.EMAIL_FROM_ADDRESS = 'news@example.org'
    const payload = fakePayload()
    await sendHtmlMail(
      payload as never,
      {
        to: ' reader@example.org ',
        subject: 'Daily\r\nBcc: x@example.org',
        text: 'text body',
        html: doc,
        fromName: 'Church "Times" <News>',
        replyTo: 'desk@example.org',
        unsubscribeUrl: 'https://cms.example.org/api/public/newsletter/one-click?token=t',
        listId: 'daily-digest.example.org',
      },
      { cap: new DailyMailCap(() => 5) },
    )
    const sent = payload.sendEmail.mock.calls[0]![0]
    expect(sent.to).toBe('reader@example.org')
    expect(sent.subject).toBe('Daily Bcc: x@example.org')
    expect(sent.text).toBe('text body')
    expect(sent.html).toBe('<p>Hello</p>')
    expect(sent.from).toEqual({ name: 'Church Times News', address: 'news@example.org' })
    expect(sent.replyTo).toBe('desk@example.org')
    expect((sent.headers as Record<string, string>)['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('refuses an invalid recipient and stops at the cap without calling the relay', async () => {
    const payload = fakePayload()
    await expect(sendHtmlMail(payload as never, { to: 'a@b.c, d@e.f', subject: 's', text: 't', html: doc })).rejects.toThrow(
      'No valid recipient',
    )
    const cap = new DailyMailCap(() => 1)
    await sendHtmlMail(payload as never, { to: 'a@example.org', subject: 's', text: 't', html: doc }, { cap })
    await expect(sendHtmlMail(payload as never, { to: 'b@example.org', subject: 's', text: 't', html: doc }, { cap })).rejects.toBeInstanceOf(
      MailCapReachedError,
    )
    expect(payload.sendEmail).toHaveBeenCalledTimes(1)
  })

  it('a relay failure still uses the slot (the provider may have counted it)', async () => {
    const payload = { sendEmail: vi.fn(async () => Promise.reject(new Error('550'))) }
    const cap = new DailyMailCap(() => 1)
    await expect(sendHtmlMail(payload as never, { to: 'a@example.org', subject: 's', text: 't', html: doc }, { cap })).rejects.toThrow('550')
    expect(cap.remaining()).toBe(0)
  })

  it('leaves the plain sender unchanged', async () => {
    const payload = fakePayload()
    await sendPlainMail(payload as never, { to: ['a@example.org', 'bad'], subject: 'x\ny', text: 'body' })
    expect(payload.sendEmail.mock.calls[0]![0]).toEqual({ to: 'a@example.org', subject: 'x y', text: 'body' })
  })
})
