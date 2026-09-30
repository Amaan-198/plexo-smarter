import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type BrowserContext, type Worker } from '@playwright/test'
import type { QueueState } from '../src/shared/types'
import { expect, test, type PlexoApp } from './fixtures'
import { sha256 } from './origin'

// X. The browser extension (extension/), loaded unpacked into a real Chromium: a download started
// on a page is handed to Plexo with the page's session, and stays in the browser when Plexo can't
// take it. Needs a Chromium that can load extensions — Playwright's own, or PLEXO_E2E_CHROMIUM.

const EXTENSION = resolve(__dirname, '..', 'extension')

/** The extension APIs these tests reach into, inside its service worker. */
declare const chrome: {
  storage: { local: { set: (items: Record<string, unknown>) => Promise<void> } }
  downloads: { search: (query: object) => Promise<{ url: string; state: string }[]> }
}

function chromiumPath(): string | null {
  const candidates = [
    process.env.PLEXO_E2E_CHROMIUM,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
  ]
  try {
    candidates.push(chromium.executablePath())
  } catch {
    // Not installed for this Playwright.
  }
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null
}

const CHROMIUM = chromiumPath()
test.skip(!CHROMIUM, 'No Chromium to load the extension into')

// Every file the queue saves lands in the test's own folder, not the user's Downloads.
test.beforeEach(async ({ plexo }) => {
  await plexo.api.queueCommand({ kind: 'setDestination', dir: plexo.dirs.dest })
})

async function waitForQueue(
  plexo: PlexoApp,
  predicate: (queue: QueueState) => boolean,
  timeout = 30_000
): Promise<QueueState> {
  const deadline = Date.now() + timeout
  let queue = await plexo.api.getQueue()
  while (!predicate(queue)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting on the queue: ${JSON.stringify(queue.items)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    queue = await plexo.api.getQueue()
  }
  return queue
}

/** A site that starts a session (a cookie) on its download page, as a file host does. */
async function startSite(fileUrl: string): Promise<{ server: Server; page: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'sid=from-the-page; Path=/'
    })
    res.end(`<!doctype html><a id="download" href="${fileUrl}">Free download</a>`)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return { server, page: `http://127.0.0.1:${port}/file/abc123/big.bin.html` }
}

async function launchBrowser(): Promise<{
  context: BrowserContext
  worker: Worker
  extensionId: string
  dispose: () => Promise<void>
}> {
  const profile = await mkdtemp(join(tmpdir(), 'plexo-chromium-'))
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: CHROMIUM!,
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])
    ]
  })
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const extensionId = new URL(worker.url()).host
  // The worker can be reachable a moment before the browser has given it its extension APIs.
  await expect
    .poll(() => worker.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage?.local))
    .toBe(true)
  return {
    context,
    worker,
    extensionId,
    dispose: async () => {
      await context.close()
      await rm(profile, { recursive: true, force: true })
    }
  }
}

test('a download started in the browser is handed to Plexo with its session', async ({
  plexo,
  serve
}) => {
  test.setTimeout(90_000)
  const origin = await serve({
    size: 900 * 1024,
    seed: 5,
    contentDisposition: 'attachment; filename="big.bin"'
  })
  // A session link: only the page's cookie gets the file.
  origin.setRule((request) =>
    /(^|; )sid=from-the-page(;|$)/.test(request.headers.cookie ?? '') ? undefined : { status: 403 }
  )
  const site = await startSite(origin.url('/dl/abc123/big.bin'))
  const { port } = (await waitForQueue(plexo, (queue) => queue.bridge.status === 'listening'))
    .bridge
  const browser = await launchBrowser()
  try {
    await browser.worker.evaluate((settings) => chrome.storage.local.set(settings), {
      port,
      allowlist: ['127.0.0.1']
    })

    // Connecting: the extension asks, the user allows it in Plexo.
    const options = await browser.context.newPage()
    await options.goto(`chrome-extension://${browser.extensionId}/options.html#connect`)
    const asking = await waitForQueue(plexo, (queue) => !!queue.bridge.pairRequest, 15_000)
    expect(asking.bridge.pairRequest?.client).toMatch(/chrom/i)
    await plexo.api.queueCommand({
      kind: 'answerPair',
      id: asking.bridge.pairRequest!.id,
      allow: true
    })
    await expect(options.locator('#status')).toHaveText('Connected')

    // The user clicks the download link.
    const page = await browser.context.newPage()
    await page.goto(site.page)
    await page.click('#download')
    // The page says where the download went.
    await expect(page.getByRole('status').filter({ hasText: 'Sent to Plexo' })).toBeVisible()

    const queue = await waitForQueue(plexo, (state) =>
      state.items.some((item) => item.status === 'completed')
    )
    const [item] = queue.items
    // The page in full, though the browser's Referer for a link on another origin is only the
    // page's origin: it's where "Get a new link" goes.
    expect(item).toMatchObject({
      source: 'browser',
      hasSession: true,
      fileName: 'big.bin',
      pageUrl: site.page
    })
    expect(sha256(await readFile(item.destinationPath!))).toBe(origin.sha256)

    // Plexo fetched it the way the browser did: its cookie, its Referer (for a link to another
    // origin, the browser sends only the page's origin, and so does Plexo) and its User-Agent.
    // The browser's own request was the one without a Range; Plexo's all have one.
    const [fromBrowser, ...rest] = origin.log
    expect(fromBrowser.range).toBeNull()
    const fromPlexo = rest.filter((request) => request.range !== null)
    expect(fromPlexo.length).toBeGreaterThan(1)
    expect(fromBrowser.headers.referer).toBeTruthy()
    for (const request of fromPlexo) {
      expect(request.headers.cookie).toBe('sid=from-the-page')
      expect(request.headers.referer).toBe(fromBrowser.headers.referer)
      expect(request.headers['user-agent']).toBe(fromBrowser.headers['user-agent'])
    }

    // And the browser's own copy is gone from its list.
    await expect
      .poll(() =>
        browser.worker.evaluate(async () =>
          (await chrome.downloads.search({})).filter((d) => d.url.includes('/dl/abc123/'))
        )
      )
      .toEqual([])
  } finally {
    await browser.dispose()
    site.server.close()
  }
})

test('with Plexo out of reach, the browser downloads it itself', async ({ plexo, serve }) => {
  test.setTimeout(60_000)
  const origin = await serve({
    size: 300 * 1024,
    seed: 6,
    contentDisposition: 'attachment; filename="fallback.bin"'
  })
  const site = await startSite(origin.url('/dl/zzz/fallback.bin'))
  const browser = await launchBrowser()
  try {
    // Connected once, but nothing answers on this port now: Plexo isn't running.
    await browser.worker.evaluate((settings) => chrome.storage.local.set(settings), {
      port: 9,
      token: 'x'.repeat(43),
      allowlist: ['127.0.0.1']
    })
    const page = await browser.context.newPage()
    await page.goto(site.page)
    const download = page.waitForEvent('download')
    await page.click('#download')
    await expect(page.getByRole('status').filter({ hasText: /Plexo isn.t running/ })).toContainText(
      'Downloading in the browser instead'
    )
    await (await download).path()

    await expect
      .poll(() =>
        browser.worker.evaluate(async () =>
          (await chrome.downloads.search({})).map((d) => ({ state: d.state, url: d.url }))
        )
      )
      .toEqual([{ state: 'complete', url: origin.url('/dl/zzz/fallback.bin') }])
    expect((await plexo.api.getQueue()).items).toEqual([])
  } finally {
    await browser.dispose()
    site.server.close()
  }
})
