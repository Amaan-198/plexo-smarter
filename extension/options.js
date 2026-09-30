import {
  connectionStatus,
  DEFAULT_PORT,
  loadSettings,
  normalizeDomain,
  pair,
  PlexoError,
  saveSettings
} from './shared.js'

/** The page's elements, all form controls or plain containers: typed as the former, whose
 * properties (value, checked, disabled) are the ones read and set here.
 * @param {string} id
 * @returns {HTMLInputElement} */
const $ = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id))

const STATUS_TEXT = {
  checking: 'Checking',
  connected: 'Connected',
  unpaired: 'Not connected',
  offline: 'Plexo not running',
  waiting: 'Waiting for Plexo'
}

let savedTimer

function flashSaved() {
  const saved = $('saved')
  saved.classList.add('show')
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => saved.classList.remove('show'), 1200)
}

async function save(patch) {
  await saveSettings(patch)
  flashSaved()
}

function setStatus(state) {
  const pill = $('status')
  pill.dataset.state = state
  pill.textContent = STATUS_TEXT[state]
}

function showNote(id, text) {
  const note = $(id)
  note.textContent = text ?? ''
  note.hidden = !text
}

async function refreshStatus() {
  const settings = await loadSettings()
  const status = await connectionStatus(settings)
  setStatus(status)
  $('connect').hidden = status !== 'unpaired'
  $('disconnect').hidden = !settings.token
  showNote(
    'connect-help',
    status === 'offline'
      ? `Plexo isn’t reachable on port ${settings.port}. Open the Plexo app, and this page connects to it.`
      : status === 'unpaired'
        ? 'Connect once, and allow it in Plexo’s window when it asks.'
        : null
  )
  return status
}

async function connect() {
  const settings = await loadSettings()
  $('connect').disabled = true
  showNote('connect-error', null)
  setStatus('waiting')
  showNote('connect-help', 'Switch to Plexo and click Allow.')
  try {
    await pair(settings)
  } catch (error) {
    showNote(
      'connect-error',
      error instanceof PlexoError && error.kind === 'offline'
        ? 'Plexo didn’t answer. Is it running?'
        : 'Plexo didn’t allow the connection.'
    )
  } finally {
    $('connect').disabled = false
  }
  await refreshStatus()
}

/** What the browser needs allowed for the extension to read a site's cookies: the site and its
 * subdomains, as the list covers them. */
function sitePatterns(site) {
  return [`*://${site}/*`, `*://*.${site}/*`]
}

async function init() {
  const settings = await loadSettings()
  $('allowlist').value = settings.allowlist.join('\n')
  $('eraseHandedOver').checked = settings.eraseHandedOver
  $('showConfirmation').checked = settings.showConfirmation
  $('port').value = String(settings.port)

  for (const id of ['eraseHandedOver', 'showConfirmation']) {
    $(id).addEventListener('change', () => {
      void save({ [id]: $(id).checked })
    })
  }
  let savedSites = settings.allowlist
  $('allowlist').addEventListener('input', () => {
    $('save-sites').disabled = false
  })
  $('save-sites').addEventListener('click', async () => {
    const wanted = [
      ...new Set($('allowlist').value.split(/\s+/).map(normalizeDomain).filter(Boolean))
    ]
    const added = wanted.filter((site) => !savedSites.includes(site))
    const removed = savedSites.filter((site) => !wanted.includes(site))
    // A site's cookies are the extension's to read only once the user has said so; asked here,
    // on the click, as the browser requires.
    const granted =
      added.length === 0 ||
      (await chrome.permissions.request({ origins: added.flatMap(sitePatterns) }))
    const allowlist = granted ? wanted : wanted.filter((site) => !added.includes(site))
    for (const site of removed) {
      // One at a time: the sites the extension comes with can't be given back, and asking to
      // would fail the rest along with them.
      await chrome.permissions.remove({ origins: sitePatterns(site) }).catch(() => {})
    }
    showNote(
      'sites-error',
      granted
        ? null
        : 'Not added: the browser wasn’t allowed to share those sites’ cookies with the extension.'
    )
    savedSites = allowlist
    $('allowlist').value = allowlist.join('\n')
    $('save-sites').disabled = true
    await save({ allowlist })
  })
  $('port').addEventListener('change', async () => {
    const value = Math.round(Number($('port').value))
    const port = value >= 1024 && value <= 65535 ? value : DEFAULT_PORT
    $('port').value = String(port)
    // A different Plexo (or none) may be listening there: this browser connects again.
    await save({ port, token: null })
    await refreshStatus()
  })
  $('connect').addEventListener('click', () => void connect())
  $('disconnect').addEventListener('click', async () => {
    await save({ token: null })
    await refreshStatus()
  })

  const status = await refreshStatus()
  // Opened from the popup's "Connect to Plexo": ask straight away.
  if (location.hash === '#connect' && status === 'unpaired') void connect()
  // Plexo may be started after this page was opened.
  setInterval(() => {
    if ($('status').dataset.state !== 'waiting') void refreshStatus()
  }, 4000)
}

void init()
