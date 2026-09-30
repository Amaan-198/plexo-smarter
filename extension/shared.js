// What the service worker, the popup and the settings page share: settings, and talking to Plexo.

export const DEFAULT_PORT = 47513

/** Everything the extension remembers, with what a fresh install starts from. */
export const DEFAULTS = {
  /** Whether downloads are handed to Plexo at all. */
  enabled: true,
  port: DEFAULT_PORT,
  /** Given by Plexo once the user allows this browser (see pair). */
  token: null,
  /** Send downloads from these sites (and their subdomains)… */
  useAllowlist: true,
  allowlist: ['filekeeper.net'],
  /** …and/or any download at least this big. */
  useSizeThreshold: false,
  minSizeMB: 100,
  /** Take handed-over downloads off the browser's own download list. */
  eraseHandedOver: true,
  /** The last few downloads handed over, newest first, for the popup. */
  recent: []
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS))
  return { ...DEFAULTS, ...stored }
}

export function saveSettings(patch) {
  return chrome.storage.local.set(patch)
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** "filekeeper.net" covers filekeeper.net and every subdomain of it (a file host's download
 * servers usually live on one). Entries are forgiving: a pasted URL or "*.site" works too. */
export function normalizeDomain(entry) {
  let text = String(entry).trim().toLowerCase()
  if (!text) return ''
  if (/^[a-z]+:\/\//.test(text)) text = hostOf(text)
  return text.replace(/^\*\./, '').replace(/^\.+|\/.*$|\.+$/g, '')
}

export function onAllowlist(host, allowlist) {
  if (!host) return false
  return allowlist.some((entry) => {
    const domain = normalizeDomain(entry)
    return domain !== '' && (host === domain || host.endsWith(`.${domain}`))
  })
}

/** The browser's name as the user knows it, for Plexo to ask "Connect Microsoft Edge?". */
export function browserName() {
  const brands = navigator.userAgentData?.brands ?? []
  const named = brands.find(({ brand }) => !/not.?a.?brand|chromium/i.test(brand))
  if (named) return named.brand
  if (/Edg\//.test(navigator.userAgent)) return 'Microsoft Edge'
  if (/OPR\//.test(navigator.userAgent)) return 'Opera'
  return 'Chrome'
}

export class PlexoError extends Error {
  constructor(kind, message) {
    super(message)
    /** 'offline' (Plexo isn't running), 'unauthorized' (not connected), or 'failed'. */
    this.kind = kind
  }
}

/** A request to Plexo's local endpoint. Plexo only listens on this computer. */
export async function plexoFetch(path, { method = 'GET', body, token, port, timeoutMs = 5000 }) {
  let response
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store'
    })
  } catch {
    throw new PlexoError('offline', 'Plexo isn’t running.')
  }
  let data = {}
  try {
    data = await response.json()
  } catch {
    // An empty or non-JSON answer: the status says enough.
  }
  if (response.status === 401) {
    throw new PlexoError('unauthorized', 'This browser isn’t connected to Plexo.')
  }
  if (!response.ok) {
    throw new PlexoError('failed', data.error || `Plexo answered ${response.status}`)
  }
  return data
}

/** Where things stand with Plexo: 'connected', 'unpaired' (running, but this browser isn't
 * allowed yet) or 'offline'. */
export async function connectionStatus(settings) {
  try {
    const status = await plexoFetch('/v1/status', {
      port: settings.port,
      token: settings.token,
      timeoutMs: 2000
    })
    if (status.app !== 'plexo') return 'offline'
    return status.paired ? 'connected' : 'unpaired'
  } catch {
    return 'offline'
  }
}

/**
 * Asks Plexo to let this browser send downloads. Plexo shows the question in its own window and
 * holds the request open until the user answers, so this takes as long as they do. Run it from
 * a page that stays open (the settings page), not the popup: the popup closes the moment the
 * user clicks over to Plexo.
 */
export async function pair(settings) {
  const { token } = await plexoFetch('/v1/pair', {
    method: 'POST',
    body: { client: browserName() },
    port: settings.port,
    timeoutMs: 100_000
  })
  await saveSettings({ token })
  return token
}

export function formatBytes(bytes) {
  if (!(bytes > 0)) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export function formatAge(ms) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}
