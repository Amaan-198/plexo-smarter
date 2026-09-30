// Watches the browser's downloads and hands the ones the user wants over to Plexo.
//
// A download it takes is paused the moment it starts, while Plexo is asked to queue it with the
// browser's session (cookies, Referer, User-Agent) — a file host's "secure session link" only
// works with those. Plexo accepted it: the browser's copy is cancelled. Plexo isn't running, or
// said no: the browser's copy just carries on, as if the extension weren't there.

import {
  hostOf,
  loadSettings,
  onAllowlist,
  PlexoError,
  plexoFetch,
  saveSettings
} from './shared.js'

const MENU_ID = 'plexo-download-link'
/** How long to wait for the browser to settle a download's file name before sending without it
 * (Plexo then takes the server's name). */
const FILENAME_WAIT_MS = 1500
const RECENT_LIMIT = 5

/** Downloads being handed over right now, so a second event for one isn't acted on twice. */
const handling = new Set()

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // Also runs on an update, when the menu may still be there: start it over.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Download with Plexo', contexts: ['link'] })
  })
  if (reason === 'install') chrome.runtime.openOptionsPage()
})

chrome.downloads.onCreated.addListener((item) => {
  void takeOver(item).catch((error) => console.error('[plexo] hand-over failed', error))
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.linkUrl) return
  void sendLink(info.linkUrl, tab?.url ?? info.pageUrl, tab?.incognito === true)
})

/** Whether the user's rules say this download goes to Plexo. */
function wanted(item, settings) {
  const hosts = [item.finalUrl, item.url, item.referrer].map(hostOf)
  if (settings.useAllowlist && hosts.some((host) => onAllowlist(host, settings.allowlist))) {
    return true
  }
  const size = knownSize(item)
  return settings.useSizeThreshold && size > 0 && size >= settings.minSizeMB * 1024 * 1024
}

function knownSize(item) {
  if (item.totalBytes > 0) return item.totalBytes
  if (item.fileSize > 0) return item.fileSize
  return 0
}

async function takeOver(item) {
  // Its own downloads (the fallback of "Download with Plexo") are the browser's to finish.
  if (item.byExtensionId === chrome.runtime.id) return
  if (item.state !== 'in_progress' || handling.has(item.id)) return
  const url = item.finalUrl || item.url
  // blob: and data: links live in the page; nothing outside the browser can fetch them. And a
  // private window's downloads stay private.
  if (!/^https?:/i.test(url) || item.incognito) return

  const settings = await loadSettings()
  if (!settings.enabled || !settings.token || !wanted(item, settings)) return

  handling.add(item.id)
  try {
    // Held still while Plexo is asked — it may be the one fetching the file in a moment.
    const paused = await chrome.downloads.pause(item.id).then(
      () => true,
      () => false
    )
    const fileName = item.filename || (await settledFileName(item.id))
    try {
      await handOver(settings, {
        url,
        fileName: baseName(fileName),
        referrer: item.referrer || undefined,
        pageUrl: await sourcePage(item.referrer),
        totalBytes: knownSize(item) || undefined,
        cookies: await sessionFor([item.url, url])
      })
    } catch (error) {
      // Plexo can't take it: the browser downloads it after all.
      if (paused) await chrome.downloads.resume(item.id).catch(() => {})
      await notice(error)
      return
    }
    await chrome.downloads.cancel(item.id).catch(() => {})
    if (settings.eraseHandedOver) await chrome.downloads.erase({ id: item.id }).catch(() => {})
  } finally {
    handling.delete(item.id)
  }
}

/** "Download with Plexo" on a link: the same hand-over, for a link that hasn't started
 * downloading. If Plexo can't take it, the browser downloads it instead. */
async function sendLink(url, pageUrl, incognito) {
  if (!/^https?:/i.test(url)) return
  const settings = await loadSettings()
  try {
    if (!settings.token) throw new PlexoError('unauthorized', 'Not connected to Plexo')
    await handOver(settings, {
      url,
      referrer: pageUrl && /^https?:/i.test(pageUrl) ? pageUrl : undefined,
      pageUrl: pageUrl && /^https?:/i.test(pageUrl) ? pageUrl : undefined,
      // A private window's session isn't sent anywhere.
      cookies: incognito ? [] : await sessionFor([url])
    })
  } catch (error) {
    await notice(error)
    await chrome.downloads.download({ url }).catch(() => {})
  }
}

async function handOver(settings, link) {
  const result = await plexoFetch('/v1/downloads', {
    method: 'POST',
    port: settings.port,
    token: settings.token,
    body: { items: [{ ...link, userAgent: navigator.userAgent }] }
  })
  const name = link.fileName || baseName(new URL(link.url).pathname) || link.url
  const recent = [
    {
      name,
      at: Date.now(),
      refreshed: result.refreshed > 0,
      duplicate: result.added === 0 && result.refreshed === 0
    },
    ...settings.recent
  ].slice(0, RECENT_LIMIT)
  await saveSettings({ recent })
  await flashBadge('✓', '#1f8a70', `Sent to Plexo: ${name}`)
}

/** What went wrong, where the user will see it: on the toolbar button. */
async function notice(error) {
  if (error instanceof PlexoError && error.kind === 'unauthorized') {
    // Plexo forgot this browser (Disconnect in Plexo): it has to be connected again.
    await saveSettings({ token: null })
    await flashBadge('!', '#d97706', 'Plexo: connect this browser again (click for details)', 0)
    return
  }
  const message =
    error instanceof PlexoError && error.kind === 'offline'
      ? 'Plexo isn’t running, so the browser downloaded it.'
      : `Plexo couldn’t take it (${error.message}), so the browser downloaded it.`
  await flashBadge('!', '#dc2626', message)
}

async function flashBadge(text, color, title, forMs = 4000) {
  await chrome.action.setBadgeBackgroundColor({ color })
  await chrome.action.setBadgeText({ text })
  await chrome.action.setTitle({ title })
  if (forMs > 0) {
    setTimeout(() => {
      void chrome.action.setBadgeText({ text: '' })
      void chrome.action.setTitle({ title: 'Plexo' })
    }, forMs)
  }
}

/** The file name, once the browser has decided it (it may be asking the user, or a server
 * header), or '' if it takes too long. */
function settledFileName(id) {
  return new Promise((resolve) => {
    const done = (name) => {
      clearTimeout(timer)
      chrome.downloads.onChanged.removeListener(onChanged)
      resolve(name)
    }
    const onChanged = (delta) => {
      if (delta.id === id && delta.filename?.current) done(delta.filename.current)
    }
    const timer = setTimeout(() => done(''), FILENAME_WAIT_MS)
    chrome.downloads.onChanged.addListener(onChanged)
    // It may have been decided between the event and now.
    void chrome.downloads.search({ id }).then(([found]) => {
      if (found?.filename) done(found.filename)
    })
  })
}

/** The browser's cookies for these URLs — what it would send them itself. Plexo sends each one
 * only where the browser would (by domain, path and https), so a redirect elsewhere gets none. */
async function sessionFor(urls) {
  const seen = new Map()
  for (const url of new Set(urls.filter(Boolean))) {
    const cookies = await chrome.cookies.getAll({ url }).catch(() => [])
    for (const cookie of cookies) {
      seen.set(`${cookie.name}\n${cookie.domain}\n${cookie.path}`, {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        hostOnly: cookie.hostOnly,
        expirationDate: cookie.session ? undefined : cookie.expirationDate
      })
    }
  }
  return [...seen.values()]
}

/**
 * The page a download came from, in full. Its Referer may be only the page's origin (what a
 * browser sends a link on another site, as a file host's download server usually is), which is
 * no use for getting a fresh link later. The tab the user is on is the page, if it's on that
 * same site.
 */
async function sourcePage(referrer) {
  if (!referrer) return undefined
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (
      tab?.url &&
      /^https?:/i.test(tab.url) &&
      new URL(tab.url).origin === new URL(referrer).origin
    ) {
      return tab.url
    }
  } catch {
    // No tab to go by.
  }
  return referrer
}

/** The browser reports a full path ("C:\Users\…\file.zip"); only the name is Plexo's business. */
function baseName(path) {
  return (path || '').split(/[\\/]/).pop() || ''
}
