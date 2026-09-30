import { isIP } from 'node:net'
import type { BrowserCookie, RequestContext } from '../../shared/types'

export const DEFAULT_USER_AGENT = 'Plexo/1.0'

/** Cookie domains are case-insensitive and may be written with a leading dot. */
function cookieDomain(cookie: Pick<BrowserCookie, 'domain'>): string {
  return cookie.domain.replace(/^\./, '').toLowerCase()
}

/** RFC 6265 §5.1.3. An IP address only ever matches itself. */
function domainMatches(host: string, cookie: BrowserCookie): boolean {
  const domain = cookieDomain(cookie)
  if (host === domain) return true
  return !cookie.hostOnly && !isIP(host) && host.endsWith(`.${domain}`)
}

/** RFC 6265 §5.1.4. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
}

/** The Cookie header a browser would send `target` from `cookies`, or null for none. Longer paths
 * first, as RFC 6265 §5.4 orders them. */
export function cookieHeader(
  target: URL,
  cookies: readonly BrowserCookie[],
  now = Date.now()
): string | null {
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const path = target.pathname || '/'
  const secure = target.protocol === 'https:'
  const sent = cookies
    .filter(
      (cookie) =>
        (cookie.expirationDate === undefined || cookie.expirationDate * 1000 > now) &&
        (!cookie.secure || secure) &&
        domainMatches(host, cookie) &&
        pathMatches(path, cookie.path || '/')
    )
    .sort((a, b) => (b.path || '/').length - (a.path || '/').length)
  return sent.length > 0 ? sent.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') : null
}

/**
 * The headers every request of a download sends `target` — each hop of a redirect included, so a
 * cookie only ever goes to the host it belongs to. Referer follows the browser's one hard rule
 * about it: an https page is never named to a plain-http server.
 */
export function requestHeaders(
  target: URL,
  context: RequestContext | undefined,
  now = Date.now()
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': context?.userAgent || DEFAULT_USER_AGENT
  }
  const referrer = context?.referrer
  if (referrer && !(referrer.startsWith('https:') && target.protocol === 'http:')) {
    headers['Referer'] = referrer
  }
  const cookie = cookieHeader(target, context?.cookies ?? [], now)
  if (cookie) headers['Cookie'] = cookie
  return headers
}

/** RFC 6265 §5.1.1's date format, which `Date.parse` reads, bar the odd two-digit year. */
function parseCookieDate(value: string): number | null {
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

/**
 * Folds a response's Set-Cookie headers into `cookies`, as a browser would on a redirect hop — a
 * file host may hand out the cookie its file server wants on the way there. Returns a new list;
 * a cookie the server deleted (expired) is dropped. Attributes Plexo has no use for (SameSite,
 * HttpOnly) are ignored: every request here is first-party to itself.
 */
export function applySetCookie(
  cookies: readonly BrowserCookie[],
  target: URL,
  setCookie: string | string[] | undefined,
  now = Date.now()
): BrowserCookie[] {
  const lines = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie]
  if (lines.length === 0) return [...cookies]
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  let result = [...cookies]

  for (const line of lines) {
    const [pair, ...attributes] = line.split(';')
    const separator = pair.indexOf('=')
    if (separator <= 0) continue
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!name || !isSafeCookieText(name) || !isSafeCookieText(value)) continue

    let domain: string | null = null
    let path: string | null = null
    let secure = false
    let expires: number | null = null
    for (const attribute of attributes) {
      const at = attribute.indexOf('=')
      const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase()
      const raw = at < 0 ? '' : attribute.slice(at + 1).trim()
      if (key === 'domain' && raw) domain = raw.replace(/^\./, '').toLowerCase()
      else if (key === 'path' && raw.startsWith('/')) path = raw
      else if (key === 'secure') secure = true
      else if (key === 'max-age' && /^-?\d+$/.test(raw)) expires = now + Number(raw) * 1000
      // Max-Age wins over Expires (§5.3 step 3), whichever comes first.
      else if (key === 'expires' && !attributes.some((a) => /^\s*max-age\s*=/i.test(a))) {
        expires = parseCookieDate(raw)
      }
    }
    // A server may only set a cookie for itself or a domain it's under (§5.3 step 6).
    if (domain !== null && host !== domain && !(host.endsWith(`.${domain}`) && !isIP(host))) {
      continue
    }
    if (secure && target.protocol !== 'https:') continue

    const defaultPath = target.pathname.slice(0, target.pathname.lastIndexOf('/')) || '/'
    const cookie: BrowserCookie = {
      name,
      value,
      domain: domain ?? host,
      path: path ?? defaultPath,
      secure,
      hostOnly: domain === null,
      ...(expires !== null ? { expirationDate: Math.floor(expires / 1000) } : {})
    }
    result = result.filter(
      (other) =>
        !(
          other.name === cookie.name &&
          cookieDomain(other) === cookieDomain(cookie) &&
          (other.path || '/') === cookie.path
        )
    )
    if (expires === null || expires > now) result.push(cookie)
  }
  return result
}

/** No separator or control character a header could be split or smuggled with. */
export function isSafeCookieText(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[;\u0000-\u001f\u007f]/.test(text)
}
