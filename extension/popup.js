import {
  connectionStatus,
  fetchQueue,
  formatBytes,
  loadSettings,
  normalizeDomain,
  saveSettings,
  splitName
} from './shared.js'

const STATUS_TEXT = {
  checking: 'Checking',
  connected: 'Connected',
  unpaired: 'Not connected',
  offline: 'Plexo not running'
}
/** How often the queue is read again while the popup is open. */
const REFRESH_MS = 1000
/** Rows shown; the rest are counted. */
const MAX_ROWS = 6

const $ = (id) => document.getElementById(id)

function describeRules(settings) {
  const sites = settings.allowlist.map(normalizeDomain).filter(Boolean)
  if (sites.length === 0) return 'Only from the right-click menu'
  return `From ${sites.length <= 2 ? sites.join(', ') : `${sites.length} sites`}`
}

// --- the queue --------------------------------------------------------------------------------

/** What's happening now first, then what's next, then what's done with. */
const ORDER = { active: 0, starting: 1, queued: 2, failed: 3, completed: 4 }

/** An item's status in a few words, and how to color it. */
function describe(item) {
  switch (item.status) {
    case 'active': {
      const percent =
        item.totalBytes > 0
          ? `${Math.min(100, Math.floor((item.bytesDownloaded / item.totalBytes) * 100))}%`
          : formatBytes(item.bytesDownloaded) || '0 B'
      if (item.paused) return { text: `Paused · ${percent}`, tone: 'normal' }
      const speed = item.speedBytesPerSec > 0 ? ` · ${formatBytes(item.speedBytesPerSec)}/s` : ''
      return { text: `${percent}${speed}`, tone: 'normal' }
    }
    case 'starting':
      return { text: 'Starting…', tone: 'normal' }
    case 'queued':
      return { text: 'Waiting', tone: 'normal' }
    case 'completed':
      return { text: 'Done', tone: 'done' }
    case 'failed':
      if (item.problem === 'expired') return { text: 'Link expired', tone: 'warn' }
      if (item.problem === 'cancelled') return { text: 'Cancelled', tone: 'normal' }
      return { text: 'Failed', tone: 'error' }
    default:
      return { text: '', tone: 'normal' }
  }
}

/** One row per item, kept from one refresh to the next and only updated, so a row doesn't
 * flicker or replay its entrance every second; rows for items that left the queue go. */
const rows = new Map()

function rowFor(item) {
  let row = rows.get(item.id)
  if (row) return row
  const li = document.createElement('li')
  const line = document.createElement('div')
  line.className = 'line'
  const name = document.createElement('span')
  name.className = 'name'
  const head = document.createElement('span')
  head.className = 'head'
  const tail = document.createElement('span')
  tail.className = 'tail'
  name.append(head, tail)
  const state = document.createElement('span')
  state.className = 'state'
  line.append(name, state)
  const bar = document.createElement('div')
  bar.className = 'bar'
  const fill = document.createElement('div')
  bar.append(fill)
  li.append(line, bar)
  row = { li, name, head, tail, state, bar, fill }
  rows.set(item.id, row)
  return row
}

function showQueue(queue) {
  const items = [...queue.items].sort((a, b) => ORDER[a.status] - ORDER[b.status])
  const shown = items.slice(0, MAX_ROWS)
  const list = $('queue')

  for (const [id, row] of rows) {
    if (!shown.some((item) => item.id === id)) {
      row.li.remove()
      rows.delete(id)
    }
  }
  shown.forEach((item, index) => {
    const row = rowFor(item)
    const { text, tone } = describe(item)
    if (row.name.title !== item.name) {
      const { head, tail } = splitName(item.name)
      row.head.textContent = head
      row.tail.textContent = tail
      row.name.title = item.name
    }
    row.state.textContent = text
    row.li.dataset.tone = tone
    row.li.dataset.paused = String(item.paused)
    const progress = item.status === 'active' && item.totalBytes > 0
    row.bar.hidden = !progress
    if (progress) {
      row.fill.style.width = `${Math.min(100, (item.bytesDownloaded / item.totalBytes) * 100)}%`
    }
    // In order, moving a row only when it's out of place.
    if (list.children[index] !== row.li) list.insertBefore(row.li, list.children[index] ?? null)
  })

  const done = queue.items.filter((item) => item.status === 'completed').length
  $('queue-summary').textContent =
    queue.items.length > 0 ? `${done} of ${queue.items.length} done` : ''
  $('queue-empty').hidden = queue.items.length > 0
  const more = items.length - shown.length
  $('queue-more').hidden = more <= 0
  $('queue-more').textContent = `+ ${more} more in Plexo`
  $('queue-block').hidden = false
}

async function refreshQueue() {
  const settings = await loadSettings()
  try {
    showQueue(await fetchQueue(settings))
  } catch {
    // Plexo went away, or forgot this browser: the status pill says which.
    $('queue-block').hidden = true
  }
}

// --- the rest ---------------------------------------------------------------------------------

async function render() {
  const settings = await loadSettings()
  $('enabled').checked = settings.enabled
  $('rules').textContent = describeRules(settings)

  const status = await connectionStatus(settings)
  const pill = $('status')
  pill.dataset.state = status
  pill.textContent = STATUS_TEXT[status]

  $('connect').hidden = status === 'connected'
  $('connect-text').textContent =
    status === 'offline'
      ? 'Open the Plexo app. Until then, downloads stay in the browser as usual.'
      : 'Allow this browser in Plexo once, and downloads you start here go to its queue.'
  $('connect-button').hidden = status === 'offline'
  if (status === 'connected') await refreshQueue()
  else $('queue-block').hidden = true
  return status
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

// Live while open: the queue every second, and the connection now and then (Plexo started or
// quit while the popup is up).
void render().then(() => {
  let ticks = 0
  setInterval(() => {
    ticks += 1
    if (ticks % 5 === 0) void render()
    else if ($('status').dataset.state === 'connected') void refreshQueue()
  }, REFRESH_MS)
})
