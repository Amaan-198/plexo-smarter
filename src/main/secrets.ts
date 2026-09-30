import { safeStorage } from 'electron'

/** A value encrypted for this user on this computer (see seal). */
interface Sealed {
  sealed: string
}

function isSealed(value: unknown): value is Sealed {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { sealed?: unknown }).sealed === 'string'
  )
}

/**
 * `value`, encrypted with the operating system's store for secrets (DPAPI on Windows, the
 * Keychain on macOS, the secret service on Linux) before it goes into a file on disk — for a
 * browser session's cookies, which the browser itself keeps encrypted. Where the system has no
 * such store, the value is kept as it is: the file is still in the user's own app data.
 */
export function seal(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    if (!safeStorage.isEncryptionAvailable()) return value
    return {
      sealed: safeStorage.encryptString(JSON.stringify(value)).toString('base64')
    } satisfies Sealed
  } catch {
    return value
  }
}

/** What `seal` stored, back as it was. A value sealed elsewhere (another user, another computer,
 * a reinstalled system) can't be opened: that's undefined, as if it had never been saved. */
export function unseal(value: unknown): unknown {
  if (!isSealed(value)) return value
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(value.sealed, 'base64')))
  } catch {
    return undefined
  }
}
