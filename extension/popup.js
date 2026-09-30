import {
  connectionStatus,
  formatAge,
  loadSettings,
  normalizeDomain,
  saveSettings
} from './shared.js'

const STATUS_TEXT = {
  checking: 'Checking',
  connected: 'Connected',
  unpaired: 'Not connected',
  offline: 'Plexo not running'
}

const $ = (id) => document.getElementById(id)

function describeRules(settings) {
  const parts = []
  if (settings.useAllowlist && settings.allowlist.length > 0) {
    const sites = settings.allowlist.map(normalizeDomain).filter(Boolean)
    parts.push(sites.length <= 2 ? sites.join(', ') : `${sites.length} sites`)
  }
  if (settings.useSizeThreshold) parts.push(`files over ${settings.minSizeMB} MB`)
  return parts.length > 0 ? `From ${parts.join(' · ')}` : 'Only from the right-click menu'
}

function showRecent(settings) {
  const list = $('recent')
  list.replaceChildren(
    ...settings.recent.map((entry) => {
      const item = document.createElement('li')
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = entry.name
      name.title = entry.name
      const when = document.createElement('span')
      when.textContent = entry.refreshed
        ? 'new link'
        : entry.duplicate
          ? 'already queued'
          : formatAge(Date.now() - entry.at)
      item.append(name, when)
      return item
    })
  )
  $('recent-block').hidden = settings.recent.length === 0
}

async function render() {
  const settings = await loadSettings()
  $('enabled').checked = settings.enabled
  $('rules').textContent = describeRules(settings)
  showRecent(settings)

  const status = await connectionStatus(settings)
  const pill = $('status')
  pill.dataset.state = status
  pill.textContent = STATUS_TEXT[status]

  const connect = $('connect')
  connect.hidden = status === 'connected'
  $('connect-text').textContent =
    status === 'offline'
      ? 'Open the Plexo app. Until then, downloads stay in the browser as usual.'
      : 'Allow this browser in Plexo once, and downloads you start here go to its queue.'
  $('connect-button').hidden = status === 'offline'
}

$('enabled').addEventListener('change', (event) => {
  void saveSettings({ enabled: event.target.checked })
})

// Connecting waits for an answer in Plexo's window, which closes this popup; the settings page
// stays open for it.
$('connect-button').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#connect') })
  window.close()
})

$('settings').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
  window.close()
})

// Whatever the toolbar badge was saying has now been seen.
void chrome.action.setBadgeText({ text: '' })
void render()
