import type { QueueItemProblem, ServerRefusal } from '../../shared/types'
import { HttpStatusError } from '../download/chunkDownloader'

export interface Failure {
  problem: QueueItemProblem
  error: string
}

/** A link that stopped leading to the file: nothing but a fresh one will help. */
export class LinkExpiredError extends Error {}

const EXPIRED_MESSAGE =
  'Link expired or no longer leads to the file. A fresh link from its page picks up where it stopped.'

/** Statuses a link that stopped working answers with: a file host's session link that ran out
 * (401, 403), or one whose file is gone (404, 410). */
const EXPIRED_STATUSES = new Set([401, 403, 404, 410])

/** Whether a server's answer means the link itself stopped working — as does a web page where
 * the file used to be (an error page, a login, a captcha), whatever its status. */
function isExpired(refusal: ServerRefusal): boolean {
  return EXPIRED_STATUSES.has(refusal.status) || refusal.webPage
}

/** Why a link couldn't be started (a probe's error), in the queue's terms. */
export function classifyError(error: unknown): Failure {
  if (error instanceof LinkExpiredError) return { problem: 'expired', error: error.message }
  if (error instanceof HttpStatusError && isExpired(error)) {
    return { problem: 'expired', error: EXPIRED_MESSAGE }
  }
  return { problem: 'other', error: error instanceof Error ? error.message : String(error) }
}

/** Why a download failed, in the queue's terms: from what its server answered, when that is what
 * ended it (see DownloadState.refusal). */
export function classifyDownload(refusal: ServerRefusal | undefined, error: string): Failure {
  return refusal && isExpired(refusal)
    ? { problem: 'expired', error: EXPIRED_MESSAGE }
    : { problem: 'other', error }
}
