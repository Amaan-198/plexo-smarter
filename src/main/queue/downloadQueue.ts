import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { app, Notification, shell, type BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type {
  AddLinksResult,
  BrowserBridgeState,
  BrowserCookie,
  DownloadState,
  DownloadStatus,
  QueueItem,
  QueueItemProblem,
  QueueLink,
  QueueState,
  RequestContext
} from '../../shared/types'
import type { DownloadEvent, DownloadManager } from '../download/downloadManager'
import { probeWithContext } from '../download/probe'
import { isSafeCookieText } from '../download/requestContext'
import { readJson, updateJson } from '../jsonFile'
import type { NetworkMonitor } from '../network/interfaces'
import { testKnobs } from '../testKnobs'

/** A queue item as saved: what the window sees, plus the browser session it was captured with,
 * which never leaves the main process. */
interface StoredItem extends QueueItem {
  context?: RequestContext
}

interface QueueFile {
  version: 1
  destinationDir?: string
  items: StoredItem[]
}

/** Downloads started for an item before a failure that isn't the link's fault (a server
 * error, a dropped connection) stops being retried on its own. */
const MAX_AUTO_ATTEMPTS = 2
/** Pasted links are looked up (size, name) in the background, this many at a time. */
const LOOKUP_CONCURRENCY = 2
const MAX_ITEMS = 5000

/** A link that stopped leading to the file: nothing but a fresh one will help. */
class LinkExpiredError extends Error {}

const EXPIRED_MESSAGE =
  'Link expired or no longer leads to the file. A fresh link from its page picks up where it stopped.'

/** Why a download or its probe failed, in the queue's terms. The messages are the download
 * manager's and probe's own (HttpStatusError, probeUrl): a 401/403/404/410 is a link that stopped
 * working — a file host's session link that ran out — and so is a 200 to a range request, which
 * is a server sending a page (an error, a captcha) where the file's bytes used to be. */
export function classifyFailure(error: unknown): { problem: QueueItemProblem; error: string } {
  if (error instanceof LinkExpiredError) return { problem: 'expired', error: error.message }
  const message = error instanceof Error ? error.message : String(error)
  if (/\bstatus (?:200|401|403|404|410)\b/.test(message)) {
    return { problem: 'expired', error: EXPIRED_MESSAGE }
  }
  return { problem: 'other', error: message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

const optionalString = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined

const optionalCount = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined

function sanitizeCookie(value: unknown): BrowserCookie | null {
  if (!isRecord(value)) return null
  const { name, value: text, domain, path, secure, hostOnly, expirationDate } = value
  if (typeof name !== 'string' || !name || name.length > 4096 || !isSafeCookieText(name)) {
    return null
  }
  if (typeof text !== 'string' || text.length > 8192 || !isSafeCookieText(text)) return null
  if (typeof domain !== 'string' || !domain || domain.length > 255) return null
  const cookie: BrowserCookie = {
    name,
    value: text,
    domain,
    path: typeof path === 'string' && path.startsWith('/') ? path : '/',
    secure: secure === true,
    hostOnly: hostOnly === true
  }
  if (typeof expirationDate === 'number' && Number.isFinite(expirationDate)) {
    cookie.expirationDate = expirationDate
  }
  return cookie
}

/** A request context from outside — the browser extension, or a file on disk — checked field by
 * field. Anything that could smuggle a header is dropped. */
export function sanitizeContext(value: unknown): RequestContext | undefined {
  if (!isRecord(value)) return undefined
  const context: RequestContext = {}
  const referrer = httpUrl(value.referrer)
  if (referrer) context.referrer = referrer
  const userAgent = optionalString(value.userAgent, 512)
  // eslint-disable-next-line no-control-regex
  if (userAgent && !/[\u0000-\u001f\u007f]/.test(userAgent)) context.userAgent = userAgent
  if (Array.isArray(value.cookies)) {
    const cookies = value.cookies
      .slice(0, 300)
      .map(sanitizeCookie)
      .filter((cookie): cookie is BrowserCookie => cookie !== null)
    if (cookies.length > 0) context.cookies = cookies
  }
  return Object.keys(context).length > 0 ? context : undefined
}

/** A link from outside (pasted, or sent by the extension), or undefined if it isn't one. */
export function sanitizeLink(value: unknown): QueueLink | undefined {
  if (!isRecord(value)) return undefined
  const url = httpUrl(value.url)
  if (!url) return undefined
  const fileName = optionalString(value.fileName, 255)?.trim()
  return {
    url,
    fileName: fileName || undefined,
    pageUrl: httpUrl(value.pageUrl),
    context: sanitizeContext(value.context),
    totalBytes: optionalCount(value.totalBytes)
  }
}

const STATUSES = new Set(['queued', 'starting', 'active', 'completed', 'failed'])
const PROBLEMS = new Set(['expired', 'cancelled', 'other'])

function sanitizeStoredItem(value: unknown): StoredItem | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  const link = sanitizeLink({ ...value, context: value.context })
  if (!link) return null
  const status = STATUSES.has(value.status as string)
    ? (value.status as StoredItem['status'])
    : 'queued'
  const now = Date.now()
  return {
    id: value.id,
    url: link.url,
    fileName: link.fileName,
    source: value.source === 'browser' ? 'browser' : 'paste',
    pageUrl: httpUrl(value.pageUrl),
    hasSession: !!link.context?.cookies?.length,
    addedAt: optionalCount(value.addedAt) ?? now,
    linkAt: optionalCount(value.linkAt) ?? now,
    status,
    totalBytes: optionalCount(value.totalBytes),
    bytesDownloaded: optionalCount(value.bytesDownloaded),
    downloadId: optionalString(value.downloadId, 64),
    destinationPath: optionalString(value.destinationPath, 4096),
    error: optionalString(value.error, 2000),
    problem: PROBLEMS.has(value.problem as string)
      ? (value.problem as QueueItemProblem)
      : undefined,
    attempts: optionalCount(value.attempts) ?? 0,
    context: link.context
  }
}

const sameName = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

const hostOf = (url: string | undefined): string | null => {
  try {
    return url ? new URL(url).hostname : null
  } catch {
    return null
  }
}

/**
 * Plexo's download queue: links waiting their turn, downloaded one at a time — one file already
 * has every network to itself, so a second at once would only split them. Each item becomes an
 * ordinary download (see DownloadManager); the queue decides when, and follows what becomes of it.
 *
 * Saved to queue.json on every change. After a relaunch the queue comes back stopped, with its
 * current download paused as the manager restores it — nothing starts until the user says so.
 */
export class DownloadQueue {
  private items: StoredItem[] = []
  private running = false
  private destinationDir = ''
  /** The current download failed outside the queue: the user moves on from it before the queue
   * does, rather than having it swept away. */
  private blocked = false
  private manager: DownloadManager | null = null
  readonly loaded: Promise<void>
  /** Everything that talks to the download manager runs one step at a time, in order. */
  private chain: Promise<void> = Promise.resolve()
  private pumpQueued = false
  private emitQueued = false
  private saveQueued = false
  private lookupsRunning = 0
  private bridge: BrowserBridgeState = { status: 'starting', port: 0, pairedCount: 0 }
  /** Tallied since the queue last had nothing to do, for the "queue finished" notification. */
  private session = { completed: 0, failed: 0 }

  constructor(
    private getWindow: () => BrowserWindow | null,
    private networks: NetworkMonitor,
    private defaultDestination: () => Promise<string>
  ) {
    this.loaded = this.load()
  }

  private filePath(): string {
    return join(app.getPath('userData'), 'queue.json')
  }

  private async load(): Promise<void> {
    let file: unknown
    try {
      file = await readJson(this.filePath())
    } catch (error) {
      console.error('[plexo] failed to read queue.json', error)
    }
    const saved = isRecord(file) ? file : {}
    const destination = saved.destinationDir
    this.destinationDir =
      typeof destination === 'string' && isAbsolute(destination)
        ? destination
        : await this.defaultDestination().catch(() => '')
    const items = Array.isArray(saved.items) ? saved.items : []
    const ids = new Set<string>()
    for (const value of items.slice(0, MAX_ITEMS)) {
      const item = sanitizeStoredItem(value)
      if (!item || ids.has(item.id)) continue
      ids.add(item.id)
      // Interrupted while being checked: it simply hadn't started.
      if (item.status === 'starting') item.status = 'queued'
      this.items.push(item)
    }
  }

  /** The downloads the queue still wants kept, should they be parked (see DownloadManager). */
  async retainedDownloads(): Promise<ReadonlySet<string>> {
    await this.loaded
    return new Set(
      this.items
        .filter((item) => item.status !== 'completed' && item.downloadId)
        .map((item) => item.downloadId!)
    )
  }

  /** Connects the queue to the download manager, once both have loaded, and squares what the
   * queue remembers with what the manager restored. */
  async attach(manager: DownloadManager): Promise<void> {
    await this.loaded
    this.manager = manager
    manager.subscribe((event) => this.onDownloadEvent(event))
    await this.enqueue(async () => {
      for (const item of this.items) {
        if (!item.downloadId) {
          if (item.status === 'active') item.status = 'queued'
          continue
        }
        const state = await manager.stateOf(item.downloadId)
        if (!state) {
          item.downloadId = undefined
          if (item.status === 'active') item.status = 'queued'
          continue
        }
        if (item.status === 'active') this.applyState(item, state)
      }
    })
    this.changed()
    this.startLookups()
  }

  // --- what the window sees -------------------------------------------------------------------

  getState(): QueueState {
    return {
      running: this.running,
      destinationDir: this.destinationDir,
      blocked: this.blocked,
      items: this.items.map((item) => {
        const view: StoredItem = { ...item }
        delete view.context
        return view
      }),
      bridge: this.bridge
    }
  }

  setBridgeState(bridge: BrowserBridgeState): void {
    this.bridge = bridge
    this.scheduleEmit()
  }

  private scheduleEmit(): void {
    if (this.emitQueued) return
    this.emitQueued = true
    setImmediate(() => {
      this.emitQueued = false
      const window = this.getWindow()
      if (window && !window.isDestroyed()) {
        window.webContents.send(IpcChannels.queueUpdated, this.getState())
      }
    })
  }

  private scheduleSave(): void {
    if (this.saveQueued) return
    this.saveQueued = true
    setImmediate(() => {
      this.saveQueued = false
      const file: QueueFile = {
        version: 1,
        destinationDir: this.destinationDir || undefined,
        items: this.items
      }
      updateJson(this.filePath(), () => file).catch((error) =>
        console.error('[plexo] failed to save queue.json', error)
      )
    })
  }

  /** Something the window shows, or the next launch needs, changed. */
  private changed(): void {
    this.scheduleSave()
    this.scheduleEmit()
  }

  // --- adding ---------------------------------------------------------------------------------

  /**
   * Adds links to the end of the queue. A link already waiting (or downloading) is skipped. A
   * browser link for a file whose earlier link is waiting on a fresh one — failed as expired, or
   * not started yet — refreshes that item in place instead: it keeps its place, and what it has
   * downloaded, and carries on from the new link.
   */
  async addLinks(
    links: QueueLink[],
    options: { source: 'paste' | 'browser'; start: boolean }
  ): Promise<AddLinksResult> {
    await this.loaded
    const result: AddLinksResult = { added: 0, duplicates: 0, refreshed: 0 }
    const now = Date.now()
    for (const raw of links) {
      const link = sanitizeLink(raw)
      if (!link) continue
      const pageUrl = link.pageUrl ?? link.context?.referrer
      const pageHost = hostOf(pageUrl)
      // The same file from the same page (or, for one that expired, the same site): same name,
      // and a page known on both sides — a name alone could be anyone's "video.mp4".
      const refreshable =
        options.source === 'browser' && pageUrl
          ? this.items.find(
              (item) =>
                (item.status === 'failed' || item.status === 'queued') &&
                item.url !== link.url &&
                sameName(item.fileName, link.fileName) &&
                (item.pageUrl === pageUrl ||
                  (item.problem === 'expired' &&
                    pageHost !== null &&
                    hostOf(item.pageUrl) === pageHost))
            )
          : undefined
      if (refreshable) {
        refreshable.url = link.url
        refreshable.context = link.context
        refreshable.hasSession = !!link.context?.cookies?.length
        refreshable.pageUrl = pageUrl ?? refreshable.pageUrl
        refreshable.linkAt = now
        refreshable.totalBytes ||= link.totalBytes
        if (refreshable.status === 'failed') this.requeue(refreshable)
        result.refreshed++
        continue
      }
      if (
        this.items.some(
          (item) => item.url === link.url && item.status !== 'completed' && item.status !== 'failed'
        )
      ) {
        result.duplicates++
        continue
      }
      if (this.items.length >= MAX_ITEMS) break
      this.items.push({
        id: randomUUID(),
        url: link.url,
        fileName: link.fileName,
        source: options.source,
        pageUrl,
        hasSession: !!link.context?.cookies?.length,
        addedAt: now,
        linkAt: now,
        status: 'queued',
        totalBytes: link.totalBytes,
        attempts: 0,
        context: link.context
      })
      result.added++
    }
    if (result.added + result.refreshed > 0) {
      if (options.start) this.running = true
      this.changed()
      this.startLookups()
      this.pump()
    }
    return result
  }

  private requeue(item: StoredItem): void {
    item.status = 'queued'
    item.error = undefined
    item.problem = undefined
  }

  /**
   * Looks up the size and name of links that were pasted without them, a couple at a time, so the
   * list says what it holds before each one's turn. A link that plainly doesn't work is marked
   * failed now rather than when its turn comes. Browser links arrive knowing both, and a session
   * link is best left untouched until its turn.
   */
  private startLookups(): void {
    while (this.lookupsRunning < LOOKUP_CONCURRENCY) {
      const item = this.items.find(
        (candidate) =>
          candidate.status === 'queued' &&
          candidate.source === 'paste' &&
          candidate.totalBytes === undefined &&
          !candidate.downloadId &&
          !this.lookingUp.has(candidate.id)
      )
      if (!item) return
      this.lookupsRunning++
      this.lookingUp.add(item.id)
      void this.lookUp(item).finally(() => {
        this.lookupsRunning--
        this.startLookups()
      })
    }
  }

  private lookingUp = new Set<string>()

  private async lookUp(item: StoredItem): Promise<void> {
    const url = item.url
    try {
      const { probe } = await probeWithContext(url, item.context)
      if (item.url !== url || item.status !== 'queued') return
      item.totalBytes = probe.totalBytes ?? 0
      item.fileName ||= probe.suggestedFileName
      this.changed()
    } catch (error) {
      if (item.url !== url || item.status !== 'queued') return
      const failure = classifyFailure(error)
      // Only a link that plainly doesn't work fails now; anything else gets its turn.
      if (failure.problem === 'expired') {
        item.status = 'failed'
        item.error = failure.error
        item.problem = failure.problem
      } else {
        item.totalBytes = 0
      }
      this.changed()
    }
  }

  // --- commands from the window ---------------------------------------------------------------

  async start(): Promise<void> {
    await this.loaded
    this.running = true
    this.blocked = false
    this.changed()
    await this.enqueue(async () => {
      const current = await this.manager?.currentState()
      if (current?.status === 'paused' && this.itemFor(current.id)) {
        this.manager?.resume(current.id)
      }
    })
    this.pump()
  }

  async stop(): Promise<void> {
    await this.loaded
    this.running = false
    this.changed()
    await this.enqueue(async () => {
      const current = await this.manager?.currentState()
      if (current?.status === 'downloading' && this.itemFor(current.id)) {
        await this.manager?.pause(current.id)
      }
    })
  }

  async retry(id: string): Promise<void> {
    await this.loaded
    const item = this.items.find((entry) => entry.id === id)
    if (!item || item.status !== 'failed') return
    this.requeue(item)
    // A retry is asked for, not automatic: it gets its own full set of attempts.
    item.attempts = 0
    this.running = true
    this.changed()
    this.pump()
  }

  async retryFailed(): Promise<void> {
    await this.loaded
    let any = false
    for (const item of this.items) {
      if (item.status !== 'failed') continue
      this.requeue(item)
      item.attempts = 0
      any = true
    }
    if (!any) return
    this.running = true
    this.changed()
    this.pump()
  }

  async remove(id: string): Promise<void> {
    await this.loaded
    const item = this.items.find((entry) => entry.id === id)
    if (!item) return
    this.items = this.items.filter((entry) => entry !== item)
    this.changed()
    const downloadId = item.downloadId
    if (downloadId) {
      // Removing the download discards what it had fetched — never the finished file.
      await this.enqueue(async () => {
        await this.manager?.remove(downloadId)
      })
    }
    this.pump()
  }

  /** Moves a waiting item one place up or down the line of waiting items. */
  move(id: string, offset: -1 | 1): void {
    const index = this.items.findIndex((entry) => entry.id === id)
    if (index < 0 || this.items[index].status !== 'queued') return
    let target = index + offset
    while (target >= 0 && target < this.items.length && this.items[target].status !== 'queued') {
      target += offset
    }
    if (target < 0 || target >= this.items.length) return
    ;[this.items[index], this.items[target]] = [this.items[target], this.items[index]]
    this.changed()
  }

  async clearFinished(): Promise<void> {
    await this.loaded
    const finished = this.items.filter((item) => item.status === 'completed')
    if (finished.length === 0) return
    this.items = this.items.filter((item) => item.status !== 'completed')
    this.changed()
    await this.enqueue(async () => {
      const current = await this.manager?.currentState()
      for (const item of finished) {
        // The one on screen stays there until the user moves on from it.
        if (item.downloadId && item.downloadId !== current?.id) {
          await this.manager?.remove(item.downloadId)
        }
      }
    })
  }

  openPage(id: string): void {
    const page = this.items.find((entry) => entry.id === id)?.pageUrl
    if (page && /^https?:/i.test(page)) void shell.openExternal(page)
  }

  setDestination(dir: string): void {
    if (typeof dir !== 'string' || !isAbsolute(dir)) return
    this.destinationDir = dir
    this.changed()
  }

  // --- following the downloads ----------------------------------------------------------------

  private itemFor(downloadId: string): StoredItem | undefined {
    return this.items.find((item) => item.downloadId === downloadId)
  }

  /** Each download's status as last seen: what tells a change of status from progress. */
  private seenStatus = new Map<string, DownloadStatus>()

  private onDownloadEvent(event: DownloadEvent): void {
    if (event.type === 'removed') {
      this.seenStatus.delete(event.id)
      const item = this.itemFor(event.id)
      if (!item) {
        // The user moved on from a download of their own: the queue can go on.
        this.pump()
        return
      }
      item.downloadId = undefined
      // Removed while it was the current download (New Download on its screen): it is done
      // with, as far as the user is concerned.
      if (item.status === 'active') {
        item.status = 'failed'
        item.problem = 'cancelled'
        item.error = 'Removed'
      }
      this.changed()
      this.pump()
      return
    }
    const { id, status } = event.state
    const statusChanged = this.seenStatus.get(id) !== status
    this.seenStatus.set(id, status)
    const item = this.itemFor(id)
    if (item) this.applyState(item, event.state)
    // A download of the user's own that finished, one way or another, frees the way.
    else if (statusChanged && status !== 'downloading' && status !== 'paused') this.pump()
  }

  /** Follows a download's state onto its item. Called for every update the download sends, so
   * anything more than bookkeeping only happens when its status changes. */
  private applyState(item: StoredItem, state: Readonly<Omit<DownloadState, 'blocks'>>): void {
    item.bytesDownloaded = state.bytesDownloaded
    if (state.totalBytes > 0) item.totalBytes = state.totalBytes
    switch (state.status) {
      case 'downloading':
      case 'paused':
        if (item.status !== 'active') {
          // Resumed outside the queue — Resume on its error screen.
          item.status = 'active'
          item.error = undefined
          item.problem = undefined
          this.changed()
        }
        return
      case 'completed':
        if (item.status === 'completed') return
        item.status = 'completed'
        item.destinationPath = state.destinationPath
        item.fileName = state.fileName
        item.error = undefined
        item.problem = undefined
        this.session.completed++
        this.changed()
        this.pump()
        return
      case 'error': {
        if (item.status !== 'active') return
        const failure = classifyFailure(state.error ?? 'The download failed')
        this.fail(item, failure)
        const downloadId = state.id
        // Kept, with what it downloaded, for a retry to pick up — but out of the way of the next.
        void this.enqueue(async () => {
          await this.manager?.park(downloadId)
        })
        this.pump()
        return
      }
      case 'cancelled':
        if (item.status !== 'active') return
        // Cancelling throws the download away; there is nothing left to resume.
        item.downloadId = undefined
        this.fail(item, { problem: 'cancelled', error: 'Cancelled' })
        this.pump()
        return
    }
  }

  /** Marks an item failed — or, for a failure that isn't the link's fault and hasn't used up
   * its attempts, sends it to the back of the queue for another go. */
  private fail(item: StoredItem, failure: { problem: QueueItemProblem; error: string }): void {
    if (failure.problem === 'other' && item.attempts < MAX_AUTO_ATTEMPTS) {
      this.requeue(item)
      this.items = [...this.items.filter((entry) => entry !== item), item]
    } else {
      item.status = 'failed'
      item.error = failure.error
      item.problem = failure.problem
      this.session.failed++
    }
    this.changed()
  }

  // --- running the queue ----------------------------------------------------------------------

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task).catch((error) => {
      console.error('[plexo] queue step failed', error)
    })
    this.chain = next
    return next
  }

  /** Starts the next item if the queue is running and nothing else is downloading. Safe to call
   * any time; calls made while one is waiting to run fold into it. */
  pump(): void {
    if (this.pumpQueued) return
    this.pumpQueued = true
    void this.enqueue(async () => {
      this.pumpQueued = false
      await this.startNext()
    })
  }

  private async startNext(): Promise<void> {
    const manager = this.manager
    if (!manager || !this.running) return
    if (await manager.isBusy()) return

    // A download of the user's own that failed stays on screen, resumable, until they move on
    // from it: starting the next item would sweep it away.
    const current = await manager.currentState()
    const blocked = current?.status === 'error' && !this.itemFor(current.id)
    if (blocked !== this.blocked) {
      this.blocked = blocked
      this.scheduleEmit()
    }
    if (blocked) return

    const item = this.items.find((entry) => entry.status === 'queued')
    if (!item) {
      this.finishSession()
      return
    }

    // The queue's finished downloads are done with; only the one on screen is still shown.
    for (const done of this.items) {
      if (done.status === 'completed' && done.downloadId) {
        const downloadId = done.downloadId
        done.downloadId = undefined
        await manager.remove(downloadId)
      }
    }

    item.status = 'starting'
    item.attempts++
    item.error = undefined
    item.problem = undefined
    this.changed()

    try {
      const { probe, context } = await probeWithContext(item.url, item.context)
      if (!this.items.includes(item)) return // removed meanwhile
      // What a file host sends once a session link has run out: its own page.
      if (probe.contentType?.startsWith('text/html') && !probe.attachment) {
        throw new LinkExpiredError(
          'The link opened a web page instead of the file, so it has probably expired. Get a fresh link from its page.'
        )
      }

      if (item.downloadId) {
        const resumed = await manager.resumeParked(item.downloadId, {
          url: probe.finalUrl,
          context
        })
        if (resumed) {
          item.status = 'active'
          this.changed()
          return
        }
        // Nothing to resume from after all (its partial file went missing): start it over.
        const stale = item.downloadId
        item.downloadId = undefined
        await manager.remove(stale)
      }

      const interfaces = await this.networks.refresh()
      if (interfaces.length === 0) throw new Error('No network connection')
      const splittable = probe.supportsRanges && probe.totalBytes !== null
      const downloadId = await manager.start({
        url: probe.finalUrl,
        destinationDir: this.destinationDir,
        // The server's own name for the file wins: what a browser reports may be its own
        // variant ("file (1).zip" for a name its downloads folder already had).
        suggestedFileName:
          (probe.attachment && probe.suggestedFileName) || item.fileName || probe.suggestedFileName,
        totalBytes: probe.totalBytes ?? 0,
        supportsRanges: splittable,
        interfaceIds: interfaces.map((iface) => iface.id),
        etag: probe.etag,
        lastModified: probe.lastModified,
        context
      })
      if (!this.items.includes(item)) {
        // Removed while it was starting: its download goes with it.
        await manager.remove(downloadId)
        return
      }
      item.downloadId = downloadId
      item.status = 'active'
      item.totalBytes = probe.totalBytes ?? item.totalBytes
      this.changed()
      // Anything it already did went by before it was this item's (see applyState).
      const state = await manager.stateOf(downloadId)
      if (state) this.applyState(item, state)
    } catch (error) {
      if (!this.items.includes(item)) return
      if (await manager.isBusy()) {
        // The user started a download of their own meanwhile: this one waits its turn again.
        item.status = 'queued'
        item.attempts--
        this.changed()
        return
      }
      this.fail(item, classifyFailure(error))
    }
    // Failed without a download to report back: go on to the next one.
    if (item.status !== 'active') this.pump()
  }

  /** Nothing left to start: says how it went, if the queue got through more than one file. */
  private finishSession(): void {
    const { completed, failed } = this.session
    this.session = { completed: 0, failed: 0 }
    if (completed + failed < 2 || testKnobs.userDataDir || !Notification.isSupported()) return
    try {
      new Notification({
        title: 'Queue finished',
        body:
          failed > 0
            ? `${completed} downloaded, ${failed} failed.`
            : `All ${completed} files downloaded.`
      }).show()
    } catch {
      // Best-effort notification
    }
  }
}
