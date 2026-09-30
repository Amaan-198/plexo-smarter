// A small confirmation card on the page the download started from — "Sent to Plexo", or why the
// browser is downloading it instead — that slides in at the corner and leaves by itself. Where a
// page can't show one (a browser page, a closed tab), a system notification says it instead.

/** How long a card stays up, unless the pointer is on it. */
const SHOW_MS = 5000

/**
 * @param {number | undefined} tabId The tab to show it in.
 * @param {{ tone: 'success' | 'info' | 'warn' | 'error', title: string, detail?: string,
 *   note?: string }} message
 */
export async function confirmOnPage(tabId, message) {
  if (tabId !== undefined && tabId >= 0) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: renderToast,
        args: [message, SHOW_MS]
      })
      return
    } catch {
      // A page an extension can't touch (edge://, the web store), or one that's gone.
    }
  }
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: message.title,
      message: [message.detail, message.note].filter(Boolean).join('\n'),
      priority: 0
    })
  } catch {
    // Notifications turned off: the toolbar badge still says it.
  }
}

/**
 * Runs in the page (it's serialized there, so it can use nothing from outside itself). Everything
 * lives in a shadow root, so the page's styles can't reach in and its own are untouched; system
 * fonts only, so nothing is loaded from the extension a page could notice.
 */
function renderToast(message, showMs) {
  const HOST_ID = 'plexo-extension-toast'
  document.getElementById(HOST_ID)?.remove()

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText =
    'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;pointer-events:none'
  const root = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    .card {
      --bg: #ffffff; --text: #1d1d1f; --muted: #6e6e73; --border: #e0e0e2; --track: #e4e4e6;
      --success: #1f8a70; --success-bg: #e6f6f2; --info: #4f64a5; --info-bg: #edf0f8;
      --warn: #b45309; --warn-bg: #fef3c7; --error: #dc2626; --error-bg: #fef2f2;
      pointer-events: auto; box-sizing: border-box; width: 340px; max-width: calc(100vw - 40px);
      display: flex; gap: 12px; align-items: flex-start; position: relative; overflow: hidden;
      padding: 13px 38px 15px 14px; border-radius: 12px; background: var(--bg); color: var(--text);
      border: 0.5px solid var(--border);
      box-shadow: 0 14px 36px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08);
      font: 13px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
      animation: in 260ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    @media (prefers-color-scheme: dark) {
      .card {
        --bg: #202325; --text: #eae7e2; --muted: #a9adb2; --border: #33383c; --track: #2b2f33;
        --success: #4ea89a; --success-bg: #22312e; --info: #7e93bd; --info-bg: #232a38;
        --warn: #e8bb6d; --warn-bg: #33291a; --error: #eda3a3; --error-bg: #2c1c1c;
        box-shadow: 0 14px 36px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3);
      }
    }
    .card.leaving { animation: out 180ms cubic-bezier(0.4, 0, 1, 1) forwards; }
    .icon {
      flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid;
      place-items: center; color: var(--tone); background: var(--tone-bg);
    }
    .icon svg { width: 15px; height: 15px; }
    .text { min-width: 0; flex: 1; }
    .title { font-weight: 600; font-size: 13px; letter-spacing: -0.005em; }
    .detail {
      margin-top: 2px; font: 12px/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace;
      color: var(--text); display: flex; min-width: 0;
    }
    /* A long name loses its middle, never its end ("…part03.rar"). */
    .detail .head { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .detail .tail { flex: none; white-space: pre; }
    .note { margin-top: 3px; font-size: 12px; color: var(--muted); }
    .close {
      position: absolute; top: 8px; right: 8px; width: 24px; height: 24px; border: 0;
      border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer;
      display: grid; place-items: center; transition: background-color 120ms, color 120ms;
    }
    .close:hover { background: var(--track); color: var(--text); }
    .close:focus-visible { outline: 2px solid var(--tone); outline-offset: 1px; }
    .close svg { width: 12px; height: 12px; }
    .timer {
      position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: var(--tone);
      opacity: 0.55; transform-origin: left;
      animation: drain linear forwards; animation-duration: ${showMs}ms;
    }
    .card:hover .timer { animation-play-state: paused; }
    @keyframes in { from { opacity: 0; transform: translateY(10px) scale(0.98); } }
    @keyframes out { to { opacity: 0; transform: translateY(6px) scale(0.98); } }
    @keyframes drain { to { transform: scaleX(0); } }
    @media (prefers-reduced-motion: reduce) {
      .card, .card.leaving { animation-duration: 1ms; }
    }
  `

  const tones = {
    success: ['var(--success)', 'var(--success-bg)', '<path d="M5 13l4 4L19 7"/>'],
    info: ['var(--info)', 'var(--info-bg)', '<path d="M12 6.5h.01M12 11v6.5"/>'],
    warn: ['var(--warn)', 'var(--warn-bg)', '<path d="M12 5.5v8M12 18h.01"/>'],
    error: ['var(--error)', 'var(--error-bg)', '<path d="M12 5.5v8M12 18h.01"/>']
  }
  const [tone, toneBg, glyph] = tones[message.tone] ?? tones.info
  const svg = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`

  const card = document.createElement('div')
  card.className = 'card'
  card.setAttribute('role', 'status')
  card.style.setProperty('--tone', tone)
  card.style.setProperty('--tone-bg', toneBg)

  const icon = document.createElement('div')
  icon.className = 'icon'
  icon.innerHTML = svg(glyph)

  // Text goes in as text, never as markup: a file name is whatever the server said.
  const text = document.createElement('div')
  text.className = 'text'
  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = message.title
  text.append(title)
  if (message.detail) {
    const detail = document.createElement('div')
    detail.className = 'detail'
    detail.title = message.detail
    const cut = message.detail.length > 20 ? message.detail.length - 16 : message.detail.length
    const head = document.createElement('span')
    head.className = 'head'
    head.textContent = message.detail.slice(0, cut)
    const tail = document.createElement('span')
    tail.className = 'tail'
    tail.textContent = message.detail.slice(cut)
    detail.append(head, tail)
    text.append(detail)
  }
  if (message.note) {
    const note = document.createElement('div')
    note.className = 'note'
    note.textContent = message.note
    text.append(note)
  }

  const close = document.createElement('button')
  close.className = 'close'
  close.type = 'button'
  close.setAttribute('aria-label', 'Dismiss')
  close.innerHTML = svg('<path d="M6 6l12 12M18 6L6 18"/>')

  const timer = document.createElement('div')
  timer.className = 'timer'

  card.append(icon, text, close, timer)
  root.append(style, card)
  document.documentElement.append(host)

  let gone = false
  const leave = () => {
    if (gone) return
    gone = true
    card.classList.add('leaving')
    card.addEventListener('animationend', () => host.remove(), { once: true })
    // Should the animation never run (a hidden tab), it still goes.
    setTimeout(() => host.remove(), 400)
  }
  close.addEventListener('click', leave)
  // The countdown bar pauses while the pointer is on the card, and so does the dismissal.
  timer.addEventListener('animationend', leave)
}
