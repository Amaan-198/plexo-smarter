import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import type { QueueItem, QueueState } from '../src/shared/types'
import { expect, interfacesEnv, LAN_ADDRESS, NETWORKS, test, type PlexoApp } from './fixtures'
import { sha256, type Origin } from './origin'

// Q. The download queue and the browser extension's local endpoint: links downloaded one after
// another, through the same download machinery as a single download, and links captured from a
// browser session carrying that session with them.

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

/** /v1/status asked by hand: fetch() won't send a Host of our choosing, nor leave Origin out. */
function statusOf(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const options = { host: '127.0.0.1', port, path: '/v1/status', method: 'POST', headers }
    const req = httpRequest(options, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

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
    init: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<Response> {
    // As the extension sends everything: a JSON POST.
    return fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: 'POST',
      headers: {
        Origin: EXTENSION_ORIGIN,
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...init.headers
      },
      body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? {})
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

// However a test ends, no download's staging file is left behind in the destination.
test.afterEach(async ({ plexo }) => {
  const staging = async (): Promise<string[]> =>
    (await readdir(plexo.dirs.dest)).filter((name) => name.endsWith('.plexo'))
  await expect.poll(staging, { message: 'no staging files left behind' }).toEqual([])
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
    expect(
      await statusOf(browser.port, {
        Host: `evil.example:${browser.port}`,
        Origin: EXTENSION_ORIGIN
      })
    ).toBe(403)
    // A page's <img> or <script>, which sends no Origin: it can't even tell Plexo is there.
    expect(await statusOf(browser.port, {})).toBe(403)
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
    expect((await browser.request('/v1/queue')).status).toBe(401)

    await browser.pair(plexo)
    const status = await browser.request('/v1/status')
    expect(await status.json()).toMatchObject({ app: 'plexo', paired: true })
    expect((await queueOf(plexo)).items).toEqual([])
    expect((await queueOf(plexo)).bridge.pairedCount).toBe(1)
    const live = await browser.request('/v1/queue')
    expect(await live.json()).toEqual({ running: false, items: [] })
  })

  test('a captured download carries its browser session to every request, and only to its own host', async ({
    plexo,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: 800 * 1024, seed: 11, bytesPerSecond: 200_000 })
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

    // The session never leaves the main process. While it's needed, it is kept encrypted on disk
    // as the browser keeps it (where the system has a store for secrets to encrypt with); once
    // the file is saved, it isn't kept at all.
    const running = await waitForQueue(plexo, (state) => !!state.items[0]?.downloadId)
    const files = [
      join(dirs.userData, 'queue.json'),
      join(dirs.userData, 'downloads', running.items[0].downloadId!, 'manifest.json')
    ]
    const encrypted = await plexo.evaluateMain(
      ({ safeStorage }) => safeStorage.isEncryptionAvailable(),
      null
    )
    if (encrypted) {
      for (const file of files) {
        await expect.poll(() => readFile(file, 'utf-8')).toContain('"sealed"')
        expect(await readFile(file, 'utf-8')).not.toContain('secret')
      }
    }

    const queue = await waitForQueue(plexo, allDone)
    const [item] = queue.items
    expect(item).toMatchObject({ source: 'browser', hasSession: true })
    // Only the name of where the browser would have saved it.
    expect(item.fileName).toBe('session file.bin')
    await expectSavedAs(item, origin)

    expect(JSON.stringify(queue)).not.toContain('secret')
    for (const file of files) {
      await expect.poll(() => readFile(file, 'utf-8')).not.toMatch(/"sealed"|secret/)
    }

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

  test('the browser can pause, resume and cancel a queued download, and a second click on one is not a second download', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 2 * 1024 * 1024, seed: 41, bytesPerSecond: 100_000 })
    const browser = await browserFor(plexo)
    await browser.pair(plexo)
    const page = 'https://files.example/download'
    await browser.send([
      { url: origin.url('/d/first/movie.part1.rar'), referrer: page, fileName: 'movie.part1.rar' }
    ])
    // The download button clicked again: a new link, the same file.
    expect(
      await browser.send([{ url: origin.url('/d/second/movie.part1.rar'), referrer: page }])
    ).toMatchObject({ added: 0, refreshed: 0, duplicates: 1 })

    const command = async (kind: string, id: string): Promise<void> => {
      const response = await browser.request('/v1/queue/command', { body: { kind, id } })
      expect(response.status).toBe(200)
    }
    const started = await waitForQueue(plexo, (queue) =>
      queue.items.some((item) => item.status === 'active' && (item.bytesDownloaded ?? 0) > 0)
    )
    expect(started.items).toHaveLength(1)
    const [item] = started.items

    await command('pause', item.id)
    await plexo.waitForStatus('paused')
    const live = (await (await browser.request('/v1/queue')).json()) as {
      items: { paused: boolean }[]
    }
    expect(live.items[0].paused).toBe(true)

    await command('resume', item.id)
    await plexo.waitForStatus('downloading')

    await command('remove', item.id)
    await waitForQueue(plexo, (queue) => queue.items.length === 0)
    // Gone, and what it had fetched with it.
    await expect.poll(() => plexo.current()).toBeNull()
    await expect.poll(async () => readdir(plexo.dirs.dest)).toEqual([])
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

test.describe('queue safety', () => {
  test('a saved queue that can’t be read is reported, and never saved over', async ({
    plexo,
    serve,
    dirs
  }) => {
    await plexo.quit()
    // Something that isn't a readable file where queue.json goes, as a lock would make it.
    const path = join(dirs.userData, 'queue.json')
    await rm(path, { force: true })
    await mkdir(path)
    await plexo.launch()
    await plexo.api.queueCommand({ kind: 'setDestination', dir: dirs.dest })

    const queue = await waitForQueue(plexo, (state) => !!state.loadError, 10_000)
    expect(queue.loadError).toMatch(/couldn’t read its saved queue/)
    // The queue still works for this session…
    const origin = await serve({ size: 100 * 1024, seed: 51 })
    await plexo.api.addToQueue([{ url: origin.url('/files/session.bin') }], { start: true })
    const [item] = (await waitForQueue(plexo, allDone)).items
    await expectSavedAs(item, origin)
    // In the folder picked while the queue was still loading, not the default one.
    expect(dirname(item.destinationPath!)).toBe(dirs.dest)
    // …but what's there is left as it was.
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  test('a change made just before quitting is saved', async ({ plexo, serve }) => {
    const origin = await serve({ size: 64 * 1024, seed: 52 })
    await plexo.api.addToQueue([{ url: origin.url('/files/late.bin') }], { start: false })
    await plexo.quit()
    await plexo.launch()
    const queue = await waitForQueue(plexo, (state) => state.items.length > 0, 10_000)
    expect(queue.items.map((item) => item.url)).toEqual([origin.url('/files/late.bin')])
  })

  test('a download started just before quitting is found again, not started twice', async ({
    plexo,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: 1024 * 1024, seed: 53, bytesPerSecond: 100_000 })
    await plexo.api.addToQueue([{ url: origin.url('/files/once.bin') }], { start: true })
    await waitForQueue(plexo, (queue) => (queue.items[0]?.bytesDownloaded ?? 0) > 0)
    await plexo.quit()

    // As if the app had quit before the queue could note which download was its item's.
    const path = join(dirs.userData, 'queue.json')
    const saved = JSON.parse(await readFile(path, 'utf-8'))
    saved.items[0].status = 'queued'
    delete saved.items[0].downloadId
    await writeFile(path, JSON.stringify(saved))

    await plexo.launch()
    const restored = await waitForQueue(plexo, (queue) => queue.items[0]?.status === 'active')
    expect(restored.items[0].downloadId).toBe((await plexo.current())?.id)
    await plexo.api.queueCommand({ kind: 'start' })
    await expectSavedAs((await waitForQueue(plexo, allDone)).items[0], origin)
    expect(await readdir(dirs.dest)).toEqual(['once.bin'])
  })

  test('removing an old download never touches the staging file of a new one by the same name', async ({
    plexo,
    serve,
    dirs
  }) => {
    const first = await serve({ size: 64 * 1024, seed: 54 })
    const oldId = await plexo.start(first.url('/files/same.bin'), first.sha256)
    await plexo.waitForStatus('completed')
    // The finished file is deleted, so the name is free for the next download of it.
    await rm(join(dirs.dest, 'same.bin'))

    const second = await serve({ size: 1024 * 1024, seed: 55, bytesPerSecond: 150_000 })
    await plexo.api.addToQueue([{ url: second.url('/other/same.bin') }], { start: true })
    await waitForQueue(plexo, (queue) => (queue.items[0]?.bytesDownloaded ?? 0) > 0)
    await plexo.api.removeDownload(oldId)

    await expectSavedAs((await waitForQueue(plexo, allDone)).items[0], second)
  })

  test('a failure is classified by what the server answered, not by its wording', async ({
    plexo,
    serve
  }) => {
    // Both answer the probe, then send a 200 where the file's bytes should be: one a web page
    // (a link that stopped working), one not (a server that stopped serving parts).
    const page = await serve({ size: 256 * 1024, seed: 56 })
    page.setRule((request) =>
      request.range && request.range.end !== 0
        ? { status: 200, headers: { 'Content-Type': 'text/html' } }
        : undefined
    )
    const whole = await serve({ size: 256 * 1024, seed: 57 })
    whole.setRule((request) =>
      request.range && request.range.end !== 0 ? { status: 200 } : undefined
    )
    await plexo.api.addToQueue(
      [{ url: page.url('/files/page.bin') }, { url: whole.url('/files/whole.bin') }],
      { start: true }
    )
    const queue = await waitForQueue(plexo, allDone, 60_000)
    const byName = (name: string): QueueItem | undefined =>
      queue.items.find((item) => item.url.endsWith(name))
    expect(byName('page.bin')).toMatchObject({ status: 'failed', problem: 'expired' })
    // Not the link's fault: it got its automatic second try before failing.
    expect(byName('whole.bin')).toMatchObject({ status: 'failed', problem: 'other', attempts: 2 })
  })

  test('the queue starts downloads only on the networks left on at the start screen', async ({
    plexo,
    serve
  }) => {
    test.skip(!LAN_ADDRESS, 'Needs a second network')
    await plexo.api.updateSettings({ excludedNetworks: ['b'] })
    const origin = await serve({ size: 512 * 1024, seed: 58 })
    await plexo.api.addToQueue([{ url: origin.url('/files/one-network.bin') }], { start: true })
    await expectSavedAs((await waitForQueue(plexo, allDone)).items[0], origin)
    const froms = new Set(origin.chunkRequests().map((request) => request.from))
    expect([...froms]).toEqual(['127.0.0.1'])
  })

  test('a fresh link that serves a different file is not stitched onto the old one', async ({
    plexo,
    serve
  }) => {
    // Same size, no ETag or Last-Modified: nothing in the headers tells the two apart.
    const size = 1536 * 1024
    const old = await serve({ size, seed: 61, etag: null, bytesPerSecond: 150_000 })
    const other = await serve({ size, seed: 62, etag: null })
    let expired = false
    old.setRule(() => (expired ? { status: 403 } : undefined))

    const browser = await browserFor(plexo)
    await browser.pair(plexo)
    const page = 'http://127.0.0.1/abc/big.bin.html'
    await browser.send([{ url: old.url('/old/big.bin'), fileName: 'big.bin', referrer: page }])
    await waitForQueue(plexo, (queue) => (queue.items[0]?.bytesDownloaded ?? 0) > size / 4)
    expired = true
    await waitForQueue(plexo, (queue) => queue.items[0]?.status === 'failed')

    expect(
      await browser.send([{ url: other.url('/new/big.bin'), fileName: 'big.bin', referrer: page }])
    ).toMatchObject({ refreshed: 1 })
    // The bytes on disk were compared with the new link's: not the same, so it started over.
    const queue = await waitForQueue(plexo, allDone)
    await expectSavedAs(queue.items[0], other)
  })
})

test.describe('the queue and the main screen', () => {
  test('Download Again on a cancelled queue download sends it back to the queue', async ({
    plexo,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: 1024 * 1024, seed: 71, bytesPerSecond: 150_000 })
    await plexo.api.addToQueue([{ url: origin.url('/files/again.bin') }], { start: true })
    const started = await waitForQueue(plexo, (queue) => (queue.items[0]?.bytesDownloaded ?? 0) > 0)
    await plexo.api.cancelDownload(started.items[0].downloadId!)
    await waitForQueue(plexo, (queue) => queue.items[0]?.problem === 'cancelled')

    await plexo.page.getByRole('button', { name: 'Download Again' }).click()
    const queue = await waitForQueue(plexo, (state) => state.items[0]?.status === 'completed')
    // The same item, downloaded into the queue's folder — not a download of its own.
    expect(queue.items).toHaveLength(1)
    await expectSavedAs(queue.items[0], origin)
    expect(dirname(queue.items[0].destinationPath!)).toBe(dirs.dest)
  })

  test('Resume on the main screen after a relaunch carries the queue on', async ({
    plexo,
    serve
  }) => {
    const slow = await serve({ size: 1024 * 1024, seed: 72, bytesPerSecond: 150_000 })
    const next = await serve({ size: 200 * 1024, seed: 73 })
    await plexo.api.addToQueue(
      [{ url: slow.url('/files/first.bin') }, { url: next.url('/files/second.bin') }],
      { start: true }
    )
    await waitForQueue(plexo, (queue) => (queue.items[0]?.bytesDownloaded ?? 0) > 0)
    await plexo.relaunch()
    await waitForQueue(plexo, (queue) => queue.items[0]?.status === 'active')

    await plexo.page.getByRole('button', { name: 'Resume', exact: true }).click()
    const queue = await waitForQueue(plexo, (state) =>
      state.items.every((item) => item.status === 'completed')
    )
    await expectSavedAs(queue.items[0], slow)
    await expectSavedAs(queue.items[1], next)
  })

  test('a download started on its own is named in the queue, which waits for it', async ({
    plexo,
    serve
  }) => {
    const queued = await serve({ size: 64 * 1024, seed: 74 })
    const own = await serve({ size: 1024 * 1024, seed: 75, bytesPerSecond: 40_000 })
    await plexo.api.addToQueue([{ url: queued.url('/files/waiting.bin') }], { start: false })

    await plexo.start(own.url('/files/own.bin'), own.sha256)
    await plexo.page.getByRole('button', { name: /^Queue/ }).click()
    await expect(plexo.page.getByRole('status').filter({ hasText: 'outside' })).toHaveText(
      'own.bin is downloading on its own, outside the queue. The queue carries on once it’s done.'
    )
    await plexo.waitForStatus('completed')
  })
})

test.describe('failures and retries', () => {
  /** What the computer's networks are now, as the app will see them at its next look. */
  const setNetworks = (plexo: PlexoApp, value: string): Promise<void> =>
    plexo.evaluateMain((_electron, networks) => {
      process.env['PLEXO_E2E_INTERFACES'] = networks
    }, value)

  test('with no network, the queue waits instead of failing every item, then carries on', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 128 * 1024, seed: 81 })
    await setNetworks(plexo, '')
    await plexo.api.addToQueue(
      [{ url: origin.url('/files/first.bin') }, { url: origin.url('/files/second.bin') }],
      { start: true }
    )
    const waiting = await waitForQueue(plexo, (queue) => queue.waitingForNetwork)
    expect(waiting.items.map((item) => [item.status, item.attempts])).toEqual([
      ['queued', 0],
      ['queued', 0]
    ])

    await setNetworks(plexo, interfacesEnv(NETWORKS))
    const queue = await waitForQueue(plexo, (state) =>
      state.items.every((item) => item.status === 'completed')
    )
    expect(queue.waitingForNetwork).toBe(false)
    for (const item of queue.items) await expectSavedAs(item, origin)
  })

  test('a folder that can’t be saved to stops the queue with the reason, failing nothing', async ({
    plexo,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: 64 * 1024, seed: 82 })
    const notAFolder = join(dirs.dest, 'not-a-folder')
    await writeFile(notAFolder, 'x')
    await plexo.api.queueCommand({ kind: 'setDestination', dir: join(notAFolder, 'inside') })
    await plexo.api.addToQueue(
      [{ url: origin.url('/files/first.bin') }, { url: origin.url('/files/second.bin') }],
      { start: true }
    )
    const stopped = await waitForQueue(plexo, (queue) => !!queue.stoppedBecause)
    expect(stopped.running).toBe(false)
    expect(stopped.stoppedBecause).toMatch(/^Can’t save to .*inside: /)
    expect(stopped.items.map((item) => [item.status, item.attempts])).toEqual([
      ['queued', 0],
      ['queued', 0]
    ])

    // Another folder, and the queue goes on from where it stopped.
    await rm(notAFolder)
    await plexo.api.queueCommand({ kind: 'setDestination', dir: dirs.dest })
    await plexo.api.queueCommand({ kind: 'start' })
    const queue = await waitForQueue(plexo, (state) =>
      state.items.every((item) => item.status === 'completed')
    )
    expect(queue.stoppedBecause).toBeUndefined()
  })

  test('a failure a moment could fix is retried shortly, in its place; one that can’t, isn’t', async ({
    plexo,
    serve
  }) => {
    const flaky = await serve({ size: 64 * 1024, seed: 83 })
    // Busy for its first two looks (the background lookup and the first start), fine after.
    let busy = 2
    flaky.setRule((request) =>
      request.range?.end === 0 && busy-- > 0 ? { status: 503 } : undefined
    )
    const refused = await serve({ size: 64 * 1024, seed: 84 })
    refused.setRule(() => ({ status: 400 }))
    const next = await serve({ size: 64 * 1024, seed: 85 })
    await plexo.api.addToQueue(
      [
        { url: flaky.url('/files/flaky.bin') },
        { url: refused.url('/files/refused.bin') },
        { url: next.url('/files/next.bin') }
      ],
      { start: true }
    )
    const queue = await waitForQueue(plexo, (state) => allDone(state) && !state.items[0].retryAt)
    // Still first in the list, done on its second try, after the others had their turn.
    expect(queue.items.map((item) => [item.status, item.attempts])).toEqual([
      ['completed', 2],
      ['failed', 1],
      ['completed', 1]
    ])
    await expectSavedAs(queue.items[0], flaky)
    const nextStarted = Math.min(...next.chunkRequests().map((request) => request.at))
    const flakyStarted = Math.min(...flaky.chunkRequests().map((request) => request.at))
    expect(nextStarted).toBeLessThan(flakyStarted)
  })

  test('pausing the queue while the next link is being checked doesn’t start it', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 256 * 1024, seed: 86 })
    // A link that answers only when the test lets it: long enough to pause in between.
    let letGo: () => void = () => {}
    const answered = new Promise<void>((resolve) => (letGo = resolve))
    const slow = createServer((req, res) => {
      void answered.then(() => {
        res.writeHead(302, { Location: origin.url(req.url ?? '/') }).end()
      })
    })
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = slow.address() as AddressInfo
      await plexo.api.addToQueue([{ url: `http://127.0.0.1:${port}/files/held.bin` }], {
        start: true
      })
      await waitForQueue(plexo, (queue) => queue.items[0]?.status === 'starting')
      // Stopping waits for the check under way, so the link answers once the queue is stopped.
      const stopping = plexo.api.queueCommand({ kind: 'stop' })
      await waitForQueue(plexo, (queue) => !queue.running)
      letGo()
      await stopping

      const queue = await waitForQueue(plexo, (state) => state.items[0]?.status === 'queued')
      expect(queue.running).toBe(false)
      expect(queue.items[0].attempts).toBe(0)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(await plexo.current()).toBeNull()
      expect(origin.chunkRequests()).toEqual([])
    } finally {
      letGo()
      slow.closeAllConnections()
      slow.close()
    }
  })

  test('New Download on a failed queue download’s screen keeps what it fetched, for Retry', async ({
    plexo,
    serve
  }) => {
    const size = 1024 * 1024
    const origin = await serve({ size, seed: 87, bytesPerSecond: 150_000 })
    let refusing = false
    origin.setRule((request) =>
      refusing && request.range && request.range.end !== 0 ? { status: 403 } : undefined
    )
    await plexo.api.addToQueue([{ url: origin.url('/files/kept.bin') }], { start: true })
    await waitForQueue(plexo, (queue) => (queue.items[0]?.bytesDownloaded ?? 0) > size / 4)
    refusing = true
    const failed = await waitForQueue(plexo, (queue) => queue.items[0]?.status === 'failed')
    const kept = failed.items[0].bytesDownloaded ?? 0

    await plexo.page.getByRole('button', { name: 'New Download' }).click()
    await expect(plexo.page.getByRole('button', { name: 'Start' })).toBeVisible()

    refusing = false
    const retriedAt = Date.now()
    await plexo.api.queueCommand({ kind: 'retry', id: failed.items[0].id })
    const [item] = (await waitForQueue(plexo, (queue) => queue.items[0]?.status === 'completed'))
      .items
    await expectSavedAs(item, origin)
    const fetchedAgain = origin
      .chunkRequests()
      .filter((request) => request.at >= retriedAt)
      .reduce((sum, request) => sum + request.bytesSent, 0)
    expect(fetchedAgain).toBeLessThanOrEqual(size - kept + 256 * 1024)
  })
})
