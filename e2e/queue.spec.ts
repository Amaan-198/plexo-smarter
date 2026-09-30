import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { QueueItem, QueueState } from '../src/shared/types'
import { expect, test, type PlexoApp } from './fixtures'
import { sha256, type Origin } from './origin'

// Q. The download queue and the browser extension's local endpoint: links downloaded one after
// another, through the same download machinery as a single download, and links captured from a
// browser session carrying that session with them.

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

async function queueOf(plexo: PlexoApp): Promise<QueueState> {
  return plexo.api.getQueue()
}

/** Waits until the queue matches `predicate`; a timeout says what it looked like instead. */
async function waitForQueue(
  plexo: PlexoApp,
  predicate: (queue: QueueState) => boolean,
  timeout = 30_000
): Promise<QueueState> {
  const deadline = Date.now() + timeout
  let queue: QueueState | null = null
  while (Date.now() < deadline) {
    queue = await queueOf(plexo)
    if (predicate(queue)) return queue
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const items = queue?.items.map(
    (item) => `${item.fileName ?? item.url}:${item.status}${item.error ? ` (${item.error})` : ''}`
  )
  throw new Error(`Timed out waiting on the queue. Last seen: [${items?.join(', ')}]`)
}

const allDone = (queue: QueueState): boolean =>
  queue.items.length > 0 &&
  queue.items.every((item) => item.status === 'completed' || item.status === 'failed')

async function expectSavedAs(item: QueueItem, origin: Origin): Promise<void> {
  expect(item.status, `${item.fileName}: ${item.error ?? ''}`).toBe('completed')
  expect(sha256(await readFile(item.destinationPath!)), `${item.fileName} matches`).toBe(
    origin.sha256
  )
}

/** The extension's side of the endpoint: what it sends, from where. */
class Browser {
  token: string | null = null

  constructor(readonly port: number) {}

  request(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: init.method ?? 'POST',
      headers: {
        Origin: EXTENSION_ORIGIN,
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...init.headers
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    })
  }

  /** Asks to connect, and has the user allow it in Plexo's window. */
  async pair(plexo: PlexoApp): Promise<void> {
    const answer = this.request('/v1/pair', { body: { client: 'Test Browser' } })
    const queue = await waitForQueue(plexo, (state) => !!state.bridge.pairRequest, 10_000)
    expect(queue.bridge.pairRequest?.client).toBe('Test Browser')
    await plexo.api.queueCommand({
      kind: 'answerPair',
      id: queue.bridge.pairRequest!.id,
      allow: true
    })
    const response = await answer
    expect(response.status).toBe(200)
    this.token = ((await response.json()) as { token: string }).token
  }

  async send(items: unknown[]): Promise<{ added: number; refreshed: number; duplicates: number }> {
    const response = await this.request('/v1/downloads', { body: { items } })
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json() as Promise<{ added: number; refreshed: number; duplicates: number }>
  }
}

async function browserFor(plexo: PlexoApp): Promise<Browser> {
  const queue = await waitForQueue(plexo, (state) => state.bridge.status !== 'starting', 10_000)
  expect(queue.bridge.status, queue.bridge.error).toBe('listening')
  return new Browser(queue.bridge.port)
}

// Every file the queue saves lands in the test's own folder, not the user's Downloads.
test.beforeEach(async ({ plexo }) => {
  await plexo.api.queueCommand({ kind: 'setDestination', dir: plexo.dirs.dest })
})

test.describe('download queue @smoke', () => {
  test('pasted links download one after another, into one folder', async ({ plexo, serve }) => {
    const origins = await Promise.all(
      [1, 2, 3].map((seed) => serve({ size: 600 * 1024, seed, bytesPerSecond: 3_000_000 }))
    )
    const urls = origins.map((origin, index) => origin.url(`/files/part${index + 1}.bin`))

    const added = await plexo.api.addToQueue(
      urls.map((url) => ({ url })),
      { start: true }
    )
    expect(added).toEqual({ added: 3, duplicates: 0, refreshed: 0 })
    // The same links again are already there.
    expect(await plexo.api.addToQueue([{ url: urls[0] }], { start: true })).toMatchObject({
      added: 0,
      duplicates: 1
    })

    const queue = await waitForQueue(plexo, allDone)
    expect(queue.items.map((item) => item.fileName)).toEqual([
      'part1.bin',
      'part2.bin',
      'part3.bin'
    ])
    for (const [index, item] of queue.items.entries()) await expectSavedAs(item, origins[index])

    // One at a time: each file's transfer only began once the one before it had finished.
    for (let index = 1; index < origins.length; index++) {
      const previousLast = Math.max(...origins[index - 1].chunkRequests().map((r) => r.at))
      const nextFirst = Math.min(...origins[index].chunkRequests().map((r) => r.at))
      expect(nextFirst, `part${index + 1} waited for part${index}`).toBeGreaterThanOrEqual(
        previousLast
      )
    }
  })

  test('a link that stopped working fails clearly, and the queue moves on', async ({
    plexo,
    serve
  }) => {
    const gone = await serve({ size: 64 * 1024 })
    gone.setRule(() => ({ status: 403 }))
    const page = await serve({ size: 64 * 1024 })
    page.setRule(() => ({ status: 200, headers: { 'Content-Type': 'text/html' } }))
    const good = await serve({ size: 300 * 1024, seed: 7 })

    await plexo.api.addToQueue(
      [
        { url: gone.url('/files/gone.bin') },
        { url: page.url('/files/page.bin') },
        { url: good.url('/files/good.bin') }
      ],
      { start: true }
    )
    const queue = await waitForQueue(plexo, allDone)
    const [first, second, third] = queue.items
    expect(first).toMatchObject({ status: 'failed', problem: 'expired' })
    expect(second).toMatchObject({ status: 'failed', problem: 'expired' })
    expect(second.error).toContain('web page')
    await expectSavedAs(third, good)
  })

  test('a relaunch brings the queue back stopped, and it carries on from there', async ({
    plexo,
    serve
  }) => {
    const slow = await serve({ size: 1024 * 1024, seed: 3, bytesPerSecond: 100_000 })
    const next = await serve({ size: 200 * 1024, seed: 4 })
    await plexo.api.addToQueue(
      [{ url: slow.url('/files/slow.bin') }, { url: next.url('/files/next.bin') }],
      { start: true }
    )
    await waitForQueue(plexo, (queue) =>
      queue.items.some((item) => item.status === 'active' && (item.bytesDownloaded ?? 0) > 0)
    )

    await plexo.relaunch()
    const restored = await waitForQueue(plexo, (queue) => queue.items.length === 2)
    expect(restored.running).toBe(false)
    expect(restored.items.map((item) => item.status)).toEqual(['active', 'queued'])
    expect((await plexo.current())?.status).toBe('paused')

    await plexo.api.queueCommand({ kind: 'start' })
    const queue = await waitForQueue(plexo, allDone)
    await expectSavedAs(queue.items[0], slow)
    await expectSavedAs(queue.items[1], next)
  })
})

test.describe('browser extension endpoint @smoke', () => {
  test('refuses web pages, rebinding and browsers the user has not allowed', async ({ plexo }) => {
    const browser = await browserFor(plexo)
    const link = { url: 'http://127.0.0.1:9/file.bin' }

    // A web page's origin, whatever it sends.
    const fromPage = await browser.request('/v1/downloads', {
      body: { items: [link] },
      headers: { Origin: 'https://evil.example' }
    })
    expect(fromPage.status).toBe(403)
    // A page reaching the loopback address through a name of its own (DNS rebinding).
    // fetch() won't send a Host of our choosing, so this one goes out by hand.
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: browser.port,
          path: '/v1/status',
          headers: { Host: `evil.example:${browser.port}` }
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.end()
    })
    expect(rebound).toBe(403)
    // Not connected yet.
    const unpaired = await browser.request('/v1/downloads', { body: { items: [link] } })
    expect(unpaired.status).toBe(401)
    // Not JSON: a form a page could post without asking first.
    const form = await browser.request('/v1/pair', {
      body: 'client=x',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })
    expect(form.status).toBe(415)

    // Turned down in Plexo: no token.
    const asking = browser.request('/v1/pair', { body: { client: 'Other Browser' } })
    const queue = await waitForQueue(plexo, (state) => !!state.bridge.pairRequest, 10_000)
    await plexo.api.queueCommand({
      kind: 'answerPair',
      id: queue.bridge.pairRequest!.id,
      allow: false
    })
    expect((await asking).status).toBe(403)

    // Allowed: the token works, and nothing was queued by any of the above.
    // Not connected: the queue isn't readable either.
    expect((await browser.request('/v1/queue', { method: 'GET' })).status).toBe(401)

    await browser.pair(plexo)
    const status = await browser.request('/v1/status', { method: 'GET' })
    expect(await status.json()).toMatchObject({ app: 'plexo', paired: true })
    expect((await queueOf(plexo)).items).toEqual([])
    expect((await queueOf(plexo)).bridge.pairedCount).toBe(1)
    const live = await browser.request('/v1/queue', { method: 'GET' })
    expect(await live.json()).toEqual({ running: false, items: [] })
  })

  test('a captured download carries its browser session to every request, and only to its own host', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 800 * 1024, seed: 11 })
    // A session link: without the browser's cookie, the server turns every request away.
    origin.setRule((request) =>
      /(^|; )sid=secret(;|$)/.test(request.headers.cookie ?? '') ? undefined : { status: 403 }
    )
    const browser = await browserFor(plexo)
    await browser.pair(plexo)

    const result = await browser.send([
      {
        url: origin.url('/dl/abc/file.bin'),
        fileName: 'C:\\Users\\me\\Downloads\\session file.bin',
        referrer: 'http://127.0.0.1/abc/file.bin.html',
        userAgent: 'Mozilla/5.0 TestBrowser',
        totalBytes: 800 * 1024,
        cookies: [
          {
            name: 'sid',
            value: 'secret',
            domain: '127.0.0.1',
            path: '/',
            secure: false,
            hostOnly: true
          },
          // Someone else's cookie, and one for another path: neither is sent here.
          {
            name: 'other',
            value: 'x',
            domain: 'example.com',
            path: '/',
            secure: false,
            hostOnly: false
          },
          {
            name: 'scoped',
            value: 'y',
            domain: '127.0.0.1',
            path: '/elsewhere',
            secure: false,
            hostOnly: true
          },
          // A secure cookie never goes over plain http.
          { name: 'tls', value: 'z', domain: '127.0.0.1', path: '/', secure: true, hostOnly: true }
        ]
      }
    ])
    expect(result.added).toBe(1)

    const queue = await waitForQueue(plexo, allDone)
    const [item] = queue.items
    expect(item).toMatchObject({ source: 'browser', hasSession: true })
    // Only the name of where the browser would have saved it.
    expect(item.fileName).toBe('session file.bin')
    await expectSavedAs(item, origin)

    // The session never leaves the main process.
    expect(JSON.stringify(queue)).not.toContain('secret')

    expect(origin.log.length).toBeGreaterThan(1)
    for (const request of origin.log) {
      expect(request.headers.cookie, `request ${request.n}`).toBe('sid=secret')
      expect(request.headers.referer).toBe('http://127.0.0.1/abc/file.bin.html')
      expect(request.headers['user-agent']).toBe('Mozilla/5.0 TestBrowser')
    }
  })

  test('a browser link only refreshes an item from the same page, never one that just shares its name', async ({
    plexo,
    serve
  }) => {
    const pasted = await serve({ size: 100 * 1024, seed: 31 })
    const captured = await serve({ size: 120 * 1024, seed: 32 })
    await plexo.api.addToQueue([{ url: pasted.url('/files/same.bin') }], { start: false })
    await waitForQueue(plexo, (queue) => queue.items[0]?.fileName === 'same.bin')

    const browser = await browserFor(plexo)
    await browser.pair(plexo)
    // Same name, but no page to tie it to the pasted one: a new item.
    expect(
      await browser.send([{ url: captured.url('/other/same.bin'), fileName: 'same.bin' }])
    ).toMatchObject({ added: 1, refreshed: 0 })

    const queue = await waitForQueue(plexo, allDone)
    expect(queue.items).toHaveLength(2)
    await expectSavedAs(queue.items[0], pasted)
    expect(queue.items[1].status).toBe('completed')
    expect(sha256(await readFile(queue.items[1].destinationPath!))).toBe(captured.sha256)
  })

  test('an expired link picks up where it stopped once the browser sends a fresh one', async ({
    plexo,
    serve
  }) => {
    const size = 1536 * 1024
    const origin = await serve({ size, seed: 21, bytesPerSecond: 150_000 })
    // The old link works for a while, then the host stops honoring it.
    let expired = false
    origin.setRule((request) =>
      request.path.startsWith('/old/') && expired ? { status: 403 } : undefined
    )
    const browser = await browserFor(plexo)
    await browser.pair(plexo)
    const page = 'http://127.0.0.1/abc/big.bin.html'
    await browser.send([
      { url: origin.url('/old/big.bin'), fileName: 'big.bin', referrer: page, totalBytes: size }
    ])

    await waitForQueue(plexo, (queue) => (queue.items[0]?.bytesDownloaded ?? 0) > size / 4)
    expired = true
    const failed = await waitForQueue(plexo, (queue) => queue.items[0]?.status === 'failed')
    expect(failed.items[0].problem).toBe('expired')
    const kept = failed.items[0].bytesDownloaded ?? 0
    expect(kept).toBeGreaterThan(0)

    // The user fetches a new link from the same page: the item is refreshed, not duplicated.
    const refreshed = await browser.send([
      { url: origin.url('/new/big.bin'), fileName: 'big.bin', referrer: page, totalBytes: size }
    ])
    expect(refreshed).toMatchObject({ added: 0, refreshed: 1 })

    const queue = await waitForQueue(plexo, allDone)
    expect(queue.items).toHaveLength(1)
    await expectSavedAs(queue.items[0], origin)
    // It resumed rather than starting over: the new link only served what was missing.
    const fetchedAgain = origin
      .chunkRequests()
      .filter((request) => request.path.startsWith('/new/'))
      .reduce((sum, request) => sum + request.bytesSent, 0)
    expect(fetchedAgain).toBeLessThanOrEqual(size - kept + 256 * 1024)
  })
})
