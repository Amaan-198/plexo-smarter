import { useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'

/** A browser's Plexo extension asking to send downloads here. Nothing is allowed until the user
 * says so in this window — a web page can't ask, and the extension can't answer for them. */
export function PairDialog(): React.JSX.Element {
  const request = useAppStore((store) => store.queue?.bridge.pairRequest)
  const allowRef = useRef<HTMLButtonElement>(null)
  // Allow also closes the dialog, which would otherwise read as a no right after the yes.
  const answeredRef = useRef<string | null>(null)
  // The last request shown, kept while the dialog animates away after it's answered.
  const [shown, setShown] = useState(request)
  if (request && request.id !== shown?.id) setShown(request)

  const answer = (allow: boolean): void => {
    if (!shown || answeredRef.current === shown.id) return
    answeredRef.current = shown.id
    void window.plexo.queueCommand({ kind: 'answerPair', id: shown.id, allow }).catch(() => {})
  }

  return (
    <AlertDialog
      open={!!request}
      onOpenChange={(open) => {
        // Escape, or any other way out, is a no.
        if (!open) answer(false)
      }}
    >
      <AlertDialogContent initialFocus={allowRef} className="max-w-[380px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Connect {shown?.client ?? 'your browser'} to Plexo?</AlertDialogTitle>
          <AlertDialogDescription className="text-[12.5px] leading-[1.5]">
            The Plexo extension will hand downloads you start in {shown?.client ?? 'the browser'}{' '}
            over to Plexo&apos;s queue, with the cookies each one needs. Only allow this if you just
            connected the extension yourself.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Don&apos;t allow</AlertDialogCancel>
          <AlertDialogAction ref={allowRef} onClick={() => answer(true)}>
            Allow
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
