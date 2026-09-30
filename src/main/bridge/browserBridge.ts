import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import type { BrowserBridgeState, QueueLink } from '../../shared/types'
import { readJson, updateJson } from '../jsonFile'
import { sanitizeContext } from '../download/requestContext'
import type { DownloadQueue } from '../queue/downloadQueue'
import { sanitizeLink } from '../queue/items'
import { testKnobs } from '../testKnobs'

/** Where the browser extension finds Plexo. Fixed, so the extension needs no setup. */
export const DEFAULT_BRIDGE_PORT = 47513

/** PLEXO_BRIDGE_PORT moves it, should another app have taken it (the extension's settings then
 * need the same number). 0 — a free port, so test apps running side by side don't collide — is
 * for development builds only. */
function bridgePort(): number {
  const raw = process.env['PLEXO_BRIDGE_PORT'] ?? ''
  if (!/^\d+$/.test(raw)) return DEFAULT_BRIDGE_PORT
  const port = Number(raw)
  if (port === 0) return app.isPackaged ? DEFAULT_BRIDGE_PORT : 0
  return port >= 1024 && port <= 65535 ? port : DEFAULT_BRIDGE_PORT
}
/** How long a browser asking to connect waits for the user to answer in Plexo. */
const PAIR_TIMEOUT_MS = 90_000
/** A few hundred links with their cookies fit easily; anything bigger isn't from the extension. */
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_LINKS_PER_REQUEST = 200
const MAX_CLIENTS = 20

interface PairedClient {
  id: string
  name: string
  /** SHA-256 of its token: the token itself is only ever known to the browser. */
  tokenHash: string
  pairedAt: number
}

interface PendingPair {
  id: string
  client: string
  settle: (token: string | null) => void
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest()

/** An extension's own origin — what a browser sends from a service worker or extension page. A
 * web page's origin (http/https) is never one, and it can't pretend to be. */
const EXTENSION_ORIGIN = /^[a-z-]+-extension:\/\/[a-z0-9-]+\/?$/i

/**
 * The local endpoint the Plexo browser extension hands downloads to. It listens on the loopback
 * address only, and trusts nothing about a request it can't check:
 *
 * - Host must name the loopback address and this port, so a web page can't reach it by pointing
 *   a domain of its own at 127.0.0.1 (DNS rebinding).
 * - Every request is a JSON POST carrying an extension's own Origin, which browsers send with an
 *   extension's POSTs and no web page can forge. A page's request carries its own origin, or none
 *   (an <img>, a <script>), and it can't send JSON across origins without a preflight this server
 *   never approves — so a page can't even find out Plexo is there by asking.
 * - Anything past /v1/status and /v1/pair takes a token that a browser only gets once the user
 *   has allowed it, in Plexo's own window (see pair). Only a hash of each token is kept on disk.
 * - Bodies are capped in size, and checked field by field before anything is queued.
 */
export class BrowserBridge {
  private server: Server | null = null
  private clients: PairedClient[] = []
  private pending: PendingPair | null = null
  private state: BrowserBridgeState = { status: 'starting', port: 0, pairedCount: 0 }

  constructor(
    private queue: DownloadQueue,
    private getWindow: () => BrowserWindow | null
  ) {}

  private filePath(): string {
    return join(app.getPath('userData'), 'browser-bridge.json')
  }

  private publish(patch: Partial<BrowserBridgeState>): void {
    this.state = { ...this.state, ...patch, pairedCount: this.clients.length }
    if (!this.pending) delete this.state.pairRequest
    this.queue.setBridgeState(this.state)
  }

  async start(): Promise<void> {
    try {
      const saved = await readJson(this.filePath())
      const clients = (saved as { clients?: unknown } | undefined)?.clients
      if (Array.isArray(clients)) {
        this.clients = clients
          .filter(
            (client): client is PairedClient =>
              typeof client?.id === 'string' &&
              typeof client?.name === 'string' &&
              typeof client?.tokenHash === 'string' &&
              /^[0-9a-f]{64}$/.test(client.tokenHash)
          )
          .slice(0, MAX_CLIENTS)
      }
    } catch (error) {
      console.error('[plexo] failed to read browser-bridge.json', error)
    }

    const port = bridgePort()
    const server = createServer((req, res) => void this.handle(req, res))
    // Keep-alive would hold a socket open per browser for nothing: requests are few and far apart.
    server.keepAliveTimeout = 1000
    server.headersTimeout = 10_000
    server.requestTimeout = PAIR_TIMEOUT_MS + 10_000
    this.server = server
    await new Promise<void>((resolve) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        this.publish({
          status: 'error',
          port,
          error:
            error.code === 'EADDRINUSE'
              ? `Port ${port} is taken by another app, so browsers can't reach Plexo. Set PLEXO_BRIDGE_PORT to another port, and the same in the extension's settings.`
              : `Couldn't listen for the browser extension: ${error.message}`
        })
        resolve()
      })
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        this.publish({
          status: 'listening',
          port: typeof address === 'object' && address ? address.port : port,
          error: undefined
        })
        resolve()
      })
    })
  }

  stop(): void {
    this.pending?.settle(null)
    this.server?.close()
    this.server = null
  }

  /** The user's answer to a browser asking to connect (see /v1/pair). */
  answerPair(id: string, allow: boolean): void {
    const pending = this.pending
    if (!pending || pending.id !== id) return
    if (!allow) {
      pending.settle(null)
      return
    }
    const token = randomBytes(32).toString('base64url')
    this.clients = [
      ...this.clients.slice(-(MAX_CLIENTS - 1)),
      {
        id: randomUUID(),
        name: pending.client,
        tokenHash: hashToken(token).toString('hex'),
        pairedAt: Date.now()
      }
    ]
    this.save()
    pending.settle(token)
  }

  /** Every browser has to ask again. */
  forgetBrowsers(): void {
    this.clients = []
    this.save()
    this.publish({})
  }

  private save(): void {
    const clients = this.clients
    updateJson(this.filePath(), () => ({ version: 1, clients })).catch((error) =>
      console.error('[plexo] failed to save browser-bridge.json', error)
    )
  }

  private authorized(req: IncomingMessage): boolean {
    const match = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(req.headers.authorization ?? '')
    if (!match) return false
    const presented = hashToken(match[1])
    // Every hash is compared, so how long a check takes says nothing about which one matched.
    let found = false
    for (const client of this.clients) {
      if (timingSafeEqual(presented, Buffer.from(client.tokenHash, 'hex'))) found = true
    }
    return found
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.checkCaller(req)
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')
      const body = await readBody(req)
      switch ((req.url ?? '/').split('?')[0]) {
        case '/v1/status':
          return send(res, 200, {
            app: 'plexo',
            version: app.getVersion(),
            paired: this.authorized(req)
          })
        case '/v1/pair':
          return await this.pair(req, res, body)
        case '/v1/downloads':
          this.requireAuthorized(req)
          return await this.add(res, body)
        case '/v1/queue':
          this.requireAuthorized(req)
          return send(res, 200, await this.queue.browserView())
        case '/v1/queue/command':
          this.requireAuthorized(req)
          return await this.command(res, body)
        default:
          throw new HttpError(404, 'Not found')
      }
    } catch (error) {
      if (res.headersSent) return
      if (error instanceof HttpError) send(res, error.status, { error: error.message })
      else send(res, 500, { error: 'Something went wrong in Plexo' })
    }
  }

  private requireAuthorized(req: IncomingMessage): void {
    if (!this.authorized(req)) throw new HttpError(401, 'This browser isn’t connected to Plexo')
  }

  private checkCaller(req: IncomingMessage): void {
    const remote = req.socket.remoteAddress ?? ''
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      throw new HttpError(403, 'Forbidden')
    }
    const port = this.state.port
    const host = (req.headers.host ?? '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      throw new HttpError(403, 'Forbidden')
    }
    if (!EXTENSION_ORIGIN.test(req.headers.origin ?? '')) throw new HttpError(403, 'Forbidden')
  }

  /**
   * A browser asks to be allowed to send downloads. Plexo asks the user, and the request is held
   * open until they answer: allowed, it gets a token to send with every download from then on.
   * Only an extension can ask — its origin is what a browser sends from it, and no web page can.
   */
  private async pair(
    req: IncomingMessage,
    res: ServerResponse,
    body: Record<string, unknown>
  ): Promise<void> {
    const client =
      typeof body.client === 'string' && body.client.trim()
        ? body.client.trim().slice(0, 60)
        : 'A browser'
    if (this.pending) throw new HttpError(409, 'Plexo is already asking about another browser')

    const token = await new Promise<string | null>((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => settle(null), PAIR_TIMEOUT_MS)
      const settle = (answer: string | null): void => {
        if (this.pending?.id !== id) return
        clearTimeout(timer)
        req.socket.off('close', onGone)
        this.pending = null
        this.publish({})
        resolve(answer)
      }
      // The browser gave up waiting: nothing to ask the user any more.
      const onGone = (): void => settle(null)
      req.socket.once('close', onGone)
      this.pending = { id, client, settle }
      this.publish({ pairRequest: { id, client } })
      this.bringWindowForward()
    })
    if (!token) throw new HttpError(403, 'Not allowed')
    send(res, 200, { token })
  }

  private async add(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const raw = Array.isArray(body.items) ? body.items : [body]
    if (raw.length > MAX_LINKS_PER_REQUEST) throw new HttpError(413, 'Too many links at once')
    const links: QueueLink[] = []
    for (const item of raw) {
      const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<
        string,
        unknown
      >
      const link = sanitizeLink({
        url: entry.url,
        fileName: typeof entry.fileName === 'string' ? baseName(entry.fileName) : undefined,
        pageUrl: entry.pageUrl,
        totalBytes: entry.totalBytes,
        context: sanitizeContext({
          referrer: entry.referrer,
          userAgent: entry.userAgent,
          cookies: entry.cookies
        })
      })
      if (link) links.push(link)
    }
    if (links.length === 0) throw new HttpError(400, 'No usable link')
    const result = await this.queue.addLinks(links, { source: 'browser', start: true })
    send(res, 200, result)
  }

  /** What the extension's popup can do to a queue item: the same as Plexo's own queue panel. */
  private async command(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const { kind, id } = body
    if (typeof id !== 'string' || !id) throw new HttpError(400, 'Which item?')
    switch (kind) {
      case 'pause':
        await this.queue.pauseItem(id)
        break
      case 'resume':
        await this.queue.resumeItem(id)
        break
      case 'retry':
        await this.queue.retry(id)
        break
      // Cancels a download (what it fetched goes); for a finished one, only the list entry.
      case 'remove':
        await this.queue.remove(id)
        break
      default:
        throw new HttpError(400, 'Unknown command')
    }
    send(res, 200, await this.queue.browserView())
  }

  private bringWindowForward(): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed() || testKnobs.hideWindow) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
}

/** A browser reports where it would have saved the file; only the name is Plexo's business. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop()?.trim() ?? ''
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Expected JSON')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large')
    chunks.push(chunk as Buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}
