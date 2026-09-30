import {
  connectionStatus,
  DEFAULT_PORT,
  loadSettings,
  normalizeDomain,
  pair,
  PlexoError,
  saveSettings
} from './shared.js'

const $ = (id) => document.getElementById(id)

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

function syncEnabledState() {
  $('allowlist-box').setAttribute('aria-disabled', String(!$('useAllowlist').checked))
  $('size-box').setAttribute('aria-disabled', String(!$('useSizeThreshold').checked))
}

async function init() {
  const settings = await loadSettings()
  $('useAllowlist').checked = settings.useAllowlist
  $('allowlist').value = settings.allowlist.join('\n')
  $('useSizeThreshold').checked = settings.useSizeThreshold
  $('minSizeMB').value = String(settings.minSizeMB)
  $('eraseHandedOver').checked = settings.eraseHandedOver
  $('showConfirmation').checked = settings.showConfirmation
  $('port').value = String(settings.port)
  syncEnabledState()

  for (const id of ['useAllowlist', 'useSizeThreshold', 'eraseHandedOver', 'showConfirmation']) {
    $(id).addEventListener('change', (event) => {
      syncEnabledState()
      void save({ [id]: event.target.checked })
    })
  }
  $('allowlist').addEventListener('change', (event) => {
    const allowlist = [
      ...new Set(event.target.value.split(/\s+/).map(normalizeDomain).filter(Boolean))
    ]
    event.target.value = allowlist.join('\n')
    void save({ allowlist })
  })
  $('minSizeMB').addEventListener('change', (event) => {
    const value = Math.round(Number(event.target.value))
    const minSizeMB = Number.isFinite(value) && value >= 1 ? value : 100
    event.target.value = String(minSizeMB)
    void save({ minSizeMB })
  })
  $('port').addEventListener('change', async (event) => {
    const value = Math.round(Number(event.target.value))
    const port = value >= 1024 && value <= 65535 ? value : DEFAULT_PORT
    event.target.value = String(port)
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
