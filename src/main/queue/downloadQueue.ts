import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { app, Notification, shell, type BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type {
  AddLinksResult,
  AppSettings,
  BrowserBridgeState,
  DownloadState,
  DownloadStatus,
  QueueItem,
  QueueItemProblem,
  QueueLink,
  QueueState
} from '../../shared/types'
import { nameOf } from '../../shared/queueItemName'
import type { DownloadEvent, DownloadManager } from '../download/downloadManager'
import { probeWithContext } from '../download/probe'
import { readJson, updateJson } from '../jsonFile'
import type { NetworkMonitor } from '../network/interfaces'
import { seal } from '../secrets'
import { testKnobs } from '../testKnobs'
import { classifyDownload, classifyError, LinkExpiredError, type Failure } from './failures'
import { hostOf, sameName, sanitizeLink, sanitizeStoredItem, type StoredItem } from './items'

/** Downloads started for an item before a failure that isn't the link's fault (a server
 * error, a dropped connection) stops being retried on its own. */
const MAX_AUTO_ATTEMPTS = 2
/** Pasted links are looked up (size, name) in the background, this many at a time. */
const LOOKUP_CONCURRENCY = 2
const MAX_ITEMS = 5000
/** queue.json may be briefly locked (antivirus, a sync client): read again this many times. */
const READ_TRIES = 5

/** One queue item as the browser extension's popup shows it (see browserView). */
export interface BrowserQueueItem {
  id: string
  name: string
  status: QueueItem['status']
  problem?: QueueItemProblem
  totalBytes: number
  bytesDownloaded: number
  speedBytesPerSec: number
  paused: boolean
  addedAt: number
  finishedAt?: number
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
  /** queue.json couldn't be read: nothing is saved over it this session, lest what it holds be
   * lost to a moment's lock. */
  private loadError: string | undefined
  private manager: DownloadManager | null = null
  readonly loaded: Promise<void>
  /** Everything that talks to the download manager runs one step at a time, in order. */
  private chain: Promise<void> = Promise.resolve()
  private pumpQueued = false
  private emitQueued = false
  private saveQueued = false
  /** The last save, for flush to wait on. */
  private saving: Promise<void> = Promise.resolve()
  private lookingUp = new Set<string>()
  /** Each download's status as last seen: what tells a change of status from progress. */
  private seenStatus = new Map<string, DownloadStatus>()
  private bridge: BrowserBridgeState = { status: 'starting', port: 0, pairedCount: 0 }
  /** Tallied since the queue last had nothing to do, for the "queue finished" notification. */
  private session = { completed: 0, failed: 0, lastName: '' }

  constructor(
    private getWindow: () => BrowserWindow | null,
    private networks: NetworkMonitor,
    /** The app's settings: where downloads go by default, and which networks are switched off. */
    private settings: () => Promise<AppSettings & { downloadsDir: string }>
  ) {
    this.loaded = this.load()
  }

  private filePath(): string {
    return join(app.getPath('userData'), 'queue.json')
  }

  private async load(): Promise<void> {
    let file: unknown
    for (let attempt = 1; ; attempt++) {
      try {
        file = await readJson(this.filePath())
        break
      } catch (error) {
        if (attempt < READ_TRIES) {
          await sleep(100 * attempt)
          continue
        }
        console.error('[plexo] failed to read queue.json', error)
        this.loadError =
          'Plexo couldn’t read its saved queue, so changes this session won’t be saved. Restart Plexo to try again.'
        break
      }
    }
    const saved = typeof file === 'object' && file !== null ? (file as Record<string, unknown>) : {}
    const destination = saved.destinationDir
    const settings = await this.settings().catch(() => null)
    this.destinationDir =
      typeof destination === 'string' && isAbsolute(destination)
        ? destination
        : (settings?.destinationDir ?? settings?.downloadsDir ?? '')
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

  /** What the queue still wants of the downloads it parked (see DownloadManager): each by its
   * download or item id — or all of them, when the queue couldn't be read to say. */
  async retainedDownloads(): Promise<ReadonlySet<string> | 'all'> {
    await this.loaded
    if (this.loadError) return 'all'
    const retained = new Set<string>()
    for (const item of this.items) {
      if (item.status === 'completed') continue
      retained.add(item.id)
      if (item.downloadId) retained.add(item.downloadId)
    }
    return retained
  }

  /** Connects the queue to the download manager, once both have loaded, and squares what the
   * queue remembers with what the manager restored — including a download it started just
   * before the app quit, faster than it could note which. */
  async attach(manager: DownloadManager): Promise<void> {
    await this.loaded
    this.manager = manager
    manager.subscribe((event) => this.onDownloadEvent(event))
    await this.enqueue(async () => {
      for (const item of this.items) {
        if (item.status === 'completed') continue
        item.downloadId ??= await manager.downloadForQueueItem(item.id)
        const state = item.downloadId ? await manager.stateOf(item.downloadId) : undefined
        if (state) this.seenStatus.set(state.id, state.status)
        if (!state) {
          item.downloadId = undefined
          if (item.status === 'active') item.status = 'queued'
          continue
        }
        if (item.status === 'queued' && state.status !== 'error') item.status = 'active'
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
      loadError: this.loadError,
      items: this.items.map((item) => {
        const view: StoredItem = { ...item }
        delete view.context
        return view
      }),
      bridge: this.bridge
    }
  }

  /** The queue as the browser extension shows it: what each item is called and where it's at,
   * live. Nothing else — no links, paths or sessions — leaves for the browser. */
  async browserView(): Promise<{ running: boolean; items: BrowserQueueItem[] }> {
    await this.loaded
    const current = await this.manager?.currentState()
    return {
      running: this.running,
      items: this.items.map((item) => {
        const live = item.status === 'active' && current?.id === item.downloadId ? current : null
        return {
          id: item.id,
          name: nameOf(item),
          status: item.status,
          problem: item.problem,
          totalBytes: live?.totalBytes || item.totalBytes || 0,
          bytesDownloaded: live?.bytesDownloaded ?? item.bytesDownloaded ?? 0,
          speedBytesPerSec: live?.status === 'downloading' ? live.speedBytesPerSec : 0,
          paused: live?.status === 'paused',
          addedAt: item.addedAt,
          finishedAt: item.finishedAt
        }
      })
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
    if (this.saveQueued || this.loadError) return
    this.saveQueued = true
    setImmediate(() => {
      if (this.saveQueued) void this.save()
    })
  }

  private save(): Promise<void> {
    this.saveQueued = false
    const file = {
      version: 1,
      destinationDir: this.destinationDir || undefined,
      // Each item's browser session is sealed (see secrets.ts), as the browser keeps its own.
      items: this.items.map((item) => ({ ...item, context: seal(item.context) }))
    }
    this.saving = updateJson(this.filePath(), () => file).catch((error) =>
      console.error('[plexo] failed to save queue.json', error)
    )
    return this.saving
  }

  /** Saves now what's waiting to be saved, and waits for it: for the app quitting. */
  async flush(): Promise<void> {
    if (this.saveQueued) await this.save()
    else await this.saving
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
      const linkName = nameOf(link)
      // The same file from the same page (or, for one that expired, the same site): same name,
      // and a page known on both sides — a name alone could be anyone's "video.mp4". Every
      // click on a file host's download button makes a new link, so the link itself can't say.
      const sameFile = (item: StoredItem): boolean =>
        options.source === 'browser' &&
        !!pageUrl &&
        sameName(nameOf(item), linkName) &&
        (item.pageUrl === pageUrl ||
          (item.problem === 'expired' && pageHost !== null && hostOf(item.pageUrl) === pageHost))

      const waiting = (item: StoredItem): boolean =>
        item.status === 'queued' || item.status === 'starting' || item.status === 'active'
      // It's in the queue already, under this link or as this file.
      if (this.items.some((item) => waiting(item) && (item.url === link.url || sameFile(item)))) {
        const refreshable = this.items.find(
          (item) => item.status === 'queued' && item.url !== link.url && sameFile(item)
        )
        if (refreshable) {
          this.refresh(refreshable, link, pageUrl, now)
          result.refreshed++
        } else {
          result.duplicates++
        }
        continue
      }
      const expired = this.items.find((item) => item.status === 'failed' && sameFile(item))
      if (expired) {
        this.refresh(expired, link, pageUrl, now)
        this.requeue(expired)
        result.refreshed++
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

  /** Gives an item a fresher link to the same file. */
  private refresh(
    item: StoredItem,
    link: QueueLink,
    pageUrl: string | undefined,
    now: number
  ): void {
    item.url = link.url
    item.context = link.context
    item.hasSession = !!link.context?.cookies?.length
    item.pageUrl = pageUrl ?? item.pageUrl
    item.linkAt = now
    item.totalBytes ||= link.totalBytes
  }

  private requeue(item: StoredItem): void {
    item.status = 'queued'
    item.error = undefined
    item.problem = undefined
    item.finishedAt = undefined
  }

  private finish(item: StoredItem, status: 'completed' | 'failed', failure?: Failure): void {
    item.status = status
    item.finishedAt = Date.now()
    item.error = failure?.error
    item.problem = failure?.problem
  }

  /**
   * Looks up the size and name of links that were pasted without them, a couple at a time, so the
   * list says what it holds before each one's turn. A link that plainly doesn't work is marked
   * failed now rather than when its turn comes. Browser links arrive knowing both, and a session
   * link is best left untouched until its turn.
   */
  private startLookups(): void {
    while (this.lookingUp.size < LOOKUP_CONCURRENCY) {
      const item = this.items.find(
        (candidate) =>
          candidate.status === 'queued' &&
          candidate.source === 'paste' &&
          candidate.totalBytes === undefined &&
          !candidate.downloadId &&
          !this.lookingUp.has(candidate.id)
      )
      if (!item) return
      this.lookingUp.add(item.id)
      void this.lookUp(item).finally(() => {
        this.lookingUp.delete(item.id)
        this.startLookups()
      })
    }
  }

  private async lookUp(item: StoredItem): Promise<void> {
    const url = item.url
    try {
      const { probe } = await probeWithContext(url, item.context)
      if (item.url !== url || item.status !== 'queued') return
      item.totalBytes = probe.totalBytes ?? 0
      item.fileName ||= probe.suggestedFileName
    } catch (error) {
      if (item.url !== url || item.status !== 'queued') return
      const failure = classifyError(error)
      // Only a link that plainly doesn't work fails now; anything else gets its turn.
      if (failure.problem === 'expired') this.finish(item, 'failed', failure)
      else item.totalBytes = 0
    }
    this.changed()
  }

  // --- commands from the window and the browser -----------------------------------------------

  private find(id: string): StoredItem | undefined {
    return this.items.find((item) => item.id === id)
  }

  /** The item's download, if it's the one the queue is on. */
  private activeDownload(id: string): string | undefined {
    const item = this.find(id)
    return item?.status === 'active' ? item.downloadId : undefined
  }

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

  /** Pauses an item's download, if it's the one running. The queue waits on it, paused, as it
   * would on a download paused in the window. */
  async pauseItem(id: string): Promise<void> {
    await this.loaded
    const downloadId = this.activeDownload(id)
    if (!downloadId) return
    await this.enqueue(async () => {
      if ((await this.manager?.stateOf(downloadId))?.status === 'downloading') {
        await this.manager?.pause(downloadId)
      }
    })
  }

  /** Resumes an item's paused download, and the queue with it. */
  async resumeItem(id: string): Promise<void> {
    await this.loaded
    const downloadId = this.activeDownload(id)
    if (!downloadId) return
    this.running = true
    this.changed()
    await this.enqueue(async () => {
      if ((await this.manager?.stateOf(downloadId))?.status === 'paused') {
        this.manager?.resume(downloadId)
      }
    })
  }

  async retry(id: string): Promise<void> {
    await this.retryWhere((item) => item.id === id)
  }

  async retryFailed(): Promise<void> {
    await this.retryWhere(() => true)
  }

  /** Sends failed items back to wait their turn. A retry is asked for, not automatic: each gets
   * its own full set of attempts. */
  private async retryWhere(which: (item: StoredItem) => boolean): Promise<void> {
    await this.loaded
    const failed = this.items.filter((item) => item.status === 'failed' && which(item))
    if (failed.length === 0) return
    for (const item of failed) {
      this.requeue(item)
      item.attempts = 0
    }
    this.running = true
    this.changed()
    this.pump()
  }

  async remove(id: string): Promise<void> {
    await this.loaded
    const item = this.find(id)
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
  async move(id: string, offset: -1 | 1): Promise<void> {
    await this.loaded
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
    const page = this.find(id)?.pageUrl
    if (page && /^https?:/i.test(page)) void shell.openExternal(page)
  }

  async setDestination(dir: string): Promise<void> {
    if (typeof dir !== 'string' || !isAbsolute(dir)) return
    // Set before the saved queue has loaded, it would be overwritten by the saved folder.
    await this.loaded
    this.destinationDir = dir
    this.changed()
  }

  // --- following the downloads ----------------------------------------------------------------

  private itemFor(downloadId: string): StoredItem | undefined {
    return this.items.find((item) => item.downloadId === downloadId)
  }

  private onDownloadEvent(event: DownloadEvent): void {
    if (event.type === 'removed') {
      this.seenStatus.delete(event.id)
      const item = this.itemFor(event.id)
      if (item) {
        item.downloadId = undefined
        // Removed while it was the current download (New Download on its screen): it is done
        // with, as far as the user is concerned.
        if (item.status === 'active') {
          this.finish(item, 'failed', { problem: 'cancelled', error: 'Removed' })
        }
        this.changed()
      }
      // Either way, the way may be free now.
      this.pump()
      return
    }
    const { id, status } = event.state
    const previous = this.seenStatus.get(id)
    const statusChanged = previous !== status
    this.seenStatus.set(id, status)
    const item = this.itemFor(id)
    if (item) {
      // One of the queue's resumed on the main screen (paused, or failed): the queue carries on
      // with it, rather than stopping once that file is done.
      const resumed = status === 'downloading' && (previous === 'paused' || previous === 'error')
      if (resumed && !this.running) {
        this.running = true
        this.changed()
      }
      this.applyState(item, event.state)
    }
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
        this.finish(item, 'completed')
        item.finishedAt = state.completedAt ?? item.finishedAt
        item.destinationPath = state.destinationPath
        item.fileName = state.fileName
        this.session.completed++
        this.session.lastName = state.fileName
        this.changed()
        this.pump()
        return
      case 'error': {
        if (item.status !== 'active') return
        this.fail(item, classifyDownload(state.refusal, state.error ?? 'The download failed'))
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
        // Cancelling throws the download away, so a retry starts over. The item keeps its id
        // while it's on screen: Download Again there sends the item back to the queue.
        this.fail(item, { problem: 'cancelled', error: 'Cancelled' })
        this.pump()
        return
    }
  }

  /** Marks an item failed — or, for a failure that isn't the link's fault and hasn't used up
   * its attempts, sends it to the back of the queue for another go. */
  private fail(item: StoredItem, failure: Failure): void {
    if (failure.problem === 'other' && item.attempts < MAX_AUTO_ATTEMPTS) {
      this.requeue(item)
      this.items = [...this.items.filter((entry) => entry !== item), item]
    } else {
      this.finish(item, 'failed', failure)
      this.session.failed++
      this.session.lastName = nameOf(item)
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

  /** The networks to start a download on: every one connected, bar those switched off on the
   * start screen — unless that would leave none. */
  private async networksToUse(): Promise<string[]> {
    const connected = (await this.networks.refresh()).map((iface) => iface.id)
    const excluded = new Set((await this.settings().catch(() => null))?.excludedNetworks ?? [])
    const chosen = connected.filter((id) => !excluded.has(id))
    return chosen.length > 0 ? chosen : connected
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
        // Nothing to resume from after all — its partial file went missing, or the new link
        // serves another file: start over from this link.
        const stale = item.downloadId
        item.downloadId = undefined
        await manager.remove(stale)
      }

      const interfaceIds = await this.networksToUse()
      if (interfaceIds.length === 0) throw new Error('No network connection')
      const downloadId = await manager.start({
        url: probe.finalUrl,
        destinationDir: this.destinationDir,
        // The server's own name for the file wins: what a browser reports may be its own
        // variant ("file (1).zip" for a name its downloads folder already had).
        suggestedFileName:
          (probe.attachment && probe.suggestedFileName) || item.fileName || probe.suggestedFileName,
        totalBytes: probe.totalBytes ?? 0,
        supportsRanges: probe.supportsRanges && probe.totalBytes !== null,
        interfaceIds,
        etag: probe.etag,
        lastModified: probe.lastModified,
        context,
        queueItemId: item.id
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
      this.fail(item, classifyError(error))
    }
    // Failed without a download to report back: go on to the next one.
    if (item.status !== 'active') this.pump()
  }

  /** Nothing left to start: says how it went — in one notification, rather than one per file
   * (the queue's downloads don't notify on their own; see DownloadManager.notifyAbout). */
  private finishSession(): void {
    const { completed, failed, lastName } = this.session
    this.session = { completed: 0, failed: 0, lastName: '' }
    if (completed + failed === 0 || testKnobs.userDataDir || !Notification.isSupported()) return
    const body =
      completed + failed === 1
        ? completed === 1
          ? `${lastName} has finished downloading.`
          : `${lastName} couldn’t be downloaded.`
        : failed > 0
          ? `${completed} downloaded, ${failed} failed.`
          : `All ${completed} files downloaded.`
    try {
      new Notification({ title: 'Queue finished', body }).show()
    } catch {
      // Best-effort notification
    }
  }
}
