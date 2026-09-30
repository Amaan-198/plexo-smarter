import type { QueueItem, QueueItemProblem, QueueLink, RequestContext } from '../../shared/types'
import { httpUrl, sanitizeContext } from '../download/requestContext'
import { unseal } from '../secrets'

/** A queue item as the queue keeps it: what the window sees, plus the browser session it was
 * captured with, which never leaves the main process. */
export interface StoredItem extends QueueItem {
  context?: RequestContext
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const optionalString = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined

const optionalCount = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined

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

const STATUSES = new Set<string>(['queued', 'starting', 'active', 'completed', 'failed'])
const PROBLEMS = new Set<string>(['expired', 'cancelled', 'other'])

/** An item as queue.json holds it — hand-editable, or from an older version, so every field is
 * checked on its own. Its session was sealed when saved (see secrets.ts). */
export function sanitizeStoredItem(value: unknown): StoredItem | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  const link = sanitizeLink({ ...value, context: unseal(value.context) })
  if (!link) return null
  const now = Date.now()
  return {
    id: value.id,
    url: link.url,
    fileName: link.fileName,
    source: value.source === 'browser' ? 'browser' : 'paste',
    pageUrl: link.pageUrl,
    hasSession: !!link.context?.cookies?.length,
    addedAt: optionalCount(value.addedAt) ?? now,
    linkAt: optionalCount(value.linkAt) ?? now,
    status: STATUSES.has(value.status as string)
      ? (value.status as StoredItem['status'])
      : 'queued',
    totalBytes: optionalCount(value.totalBytes),
    bytesDownloaded: optionalCount(value.bytesDownloaded),
    downloadId: optionalString(value.downloadId, 64),
    destinationPath: optionalString(value.destinationPath, 4096),
    saveDir: optionalString(value.saveDir, 4096),
    error: optionalString(value.error, 2000),
    problem: PROBLEMS.has(value.problem as string)
      ? (value.problem as QueueItemProblem)
      : undefined,
    attempts: optionalCount(value.attempts) ?? 0,
    finishedAt: optionalCount(value.finishedAt),
    context: link.context
  }
}

export const sameName = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

export function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname : null
  } catch {
    return null
  }
}
