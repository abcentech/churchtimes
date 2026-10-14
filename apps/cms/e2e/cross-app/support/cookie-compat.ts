/**
 * WebKit only: the CMS (production build, as in real staging) sets its session cookie with `Secure`. This lane serves
 * everything over plain http on *.churchtimes.localhost, and WebKit (unlike Chromium and Firefox, which exempt localhost)
 * refuses to store a `Secure` cookie received over http, so no staff login can ever stick in a WebKit project
 * (probed: Set-Cookie "a=1; HttpOnly; SameSite=Lax; Secure" is dropped, without `Secure` it is kept).
 *
 * Real staging runs on https, where the product behaviour is correct, so this is a LANE limitation, not a product bug.
 * The recording proxy therefore removes the `Secure` attribute from Set-Cookie headers (Payload writes it as `Secure=true`), and ONLY for responses to a
 * WebKit client (User-Agent has Safari/ but neither Chrome/ nor Firefox/). Chromium and Firefox still get the real header.
 * Everything else (HttpOnly, SameSite=Lax, Path, Expires, the CSRF origin checks) is untouched.
 */
import type { IncomingHttpHeaders } from 'node:http'

const isWebKit = (ua: string | undefined): boolean => !!ua && /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Firefox\/|Edg\//.test(ua)

export function webkitHttpCookieCompat(req: IncomingHttpHeaders, res: IncomingHttpHeaders): IncomingHttpHeaders {
  const cookies = res['set-cookie']
  if (!cookies || !isWebKit(req['user-agent'])) return res
  return { ...res, 'set-cookie': cookies.map((c) => c.replace(/;\s*Secure(?:=[^;]*)?\s*(?=;|$)/gi, '')) }
}
