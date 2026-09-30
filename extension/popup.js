import {
  connectionStatus,
  fetchQueue,
  formatBytes,
  loadSettings,
  normalizeDomain,
  queueCommand,
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

/** The page's elements, all form controls or plain containers: typed as the former, whose
 * properties (value, checked, disabled) are the ones read and set here.
 * @param {string} id
 * @returns {HTMLInputElement} */
const $ = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id))

function describeRules(settings) {
  const sites = settings.allowlist.map(normalizeDomain).filter(Boolean)
  if (sites.length === 0) return 'Only from the right-click menu'
  return `From ${sites.length <= 2 ? sites.join(', ') : `${sites.length} sites`}`
}

// --- the queue --------------------------------------------------------------------------------

/** How long Cancel waits for its second click before standing down. */
const CONFIRM_MS = 3000
const isRunning = (item) => item.status === 'active' || item.status === 'starting'
const isFinished = (item) => item.status === 'completed' || item.status === 'failed'

/**
 * The rows to show, newest on top: what's waiting (the last in line highest, the next one just
 * above the download), then what's downloading, then what finished (most recent first). With
 * more than fit, what's downloading always shows, then the next few in line and the latest
 * few finished.
 */
function pickRows(items) {
  const running = items.filter(isRunning)
  const waiting = items.filter((item) => item.status === 'queued')
  const finished = items
    .filter(isFinished)
    .sort((a, b) => (b.finishedAt ?? b.addedAt) - (a.finishedAt ?? a.addedAt))
  const room = Math.max(0, MAX_ROWS - running.length)
  let next = Math.min(waiting.length, Math.max(0, room - Math.min(finished.length, 2)))
  const done = Math.min(finished.length, room - next)
  next = Math.min(waiting.length, room - done)
  return [...waiting.slice(0, next).reverse(), ...running, ...finished.slice(0, done)]
}

const ICONS = {
  pause: '<path d="M9 6v12M15 6v12"/>',
  resume: '<path d="M8 5.5v13l10.5-6.5z"/>',
  retry: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  remove: '<path d="M6 6l12 12M18 6L6 18"/>'
}

/** The row's buttons for what can be done to the item now. */
function actionsFor(item) {
  if (item.status === 'active') {
    return [
      item.paused ? { kind: 'resume', label: 'Resume' } : { kind: 'pause', label: 'Pause' },
      { kind: 'remove', label: 'Cancel download', confirm: true }
    ]
  }
  if (item.status === 'starting') return [{ kind: 'remove', label: 'Cancel', confirm: true }]
  if (item.status === 'queued') return [{ kind: 'remove', label: 'Cancel' }]
  if (item.status === 'failed') {
    return [
      { kind: 'retry', label: 'Retry' },
      { kind: 'remove', label: 'Remove' }
    ]
  }
  return [{ kind: 'remove', label: 'Remove from list (the file stays)' }]
}

function iconSvg(paths) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
}

async function run(kind, id) {
  const settings = await loadSettings()
  try {
    showQueue(await queueCommand(settings, kind, id))
  } catch {
    await refreshQueue()
  }
}

function buildActions(row, item) {
  row.actions.replaceChildren(
    ...actionsFor(item).map((action) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'act'
      button.dataset.kind = action.kind
      button.title = action.label
      button.setAttribute('aria-label', `${action.label}: ${item.name}`)
      button.innerHTML = iconSvg(ICONS[action.kind])
      let timer
      button.addEventListener('click', () => {
        // What it downloaded goes with it: a second click says so.
        if (action.confirm && !button.classList.contains('confirming')) {
          button.classList.add('confirming')
          button.textContent = 'Cancel?'
          button.setAttribute('aria-label', `Confirm: cancel ${item.name}`)
          timer = setTimeout(() => {
            button.classList.remove('confirming')
            button.innerHTML = iconSvg(ICONS[action.kind])
            button.setAttribute('aria-label', `${action.label}: ${item.name}`)
          }, CONFIRM_MS)
          return
        }
        clearTimeout(timer)
        button.disabled = true
        void run(action.kind, item.id)
      })
      return button
    })
  )
}

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
  const actions = document.createElement('span')
  actions.className = 'actions'
  line.append(name, state, actions)
  const bar = document.createElement('div')
  bar.className = 'bar'
  const fill = document.createElement('div')
  bar.append(fill)
  li.append(line, bar)
  row = { li, name, head, tail, state, actions, bar, fill, signature: '' }
  rows.set(item.id, row)
  return row
}

function showQueue(queue) {
  const shown = pickRows(queue.items)
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
    // Rebuilt only when what can be done changes, so a Cancel waiting for its confirming
    // click isn't reset by the next refresh.
    const signature = `${item.status}:${item.paused}`
    if (row.signature !== signature) {
      row.signature = signature
      buildActions(row, item)
    }
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
  const more = queue.items.length - shown.length
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

$('enabled').addEventListener('change', () => {
  void saveSettings({ enabled: $('enabled').checked })
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
