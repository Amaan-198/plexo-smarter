import { holdsFolder, nameOf } from '@shared/queueItem'
import { cn } from 'cn'
import { useAppStore } from '../store/useAppStore'
import { toDisplayPath } from '../utils/format'
import { Button } from './ui/button'

/** The queue's folder, which items are saved to, and a way to pick another. A new folder is for
 * the items not started yet: one under way finishes where it started, which this says. */
export function QueueDestination({ className }: { className?: string }): React.JSX.Element {
  const destinationDir = useAppStore((store) => store.queue?.destinationDir)
  const items = useAppStore((store) => store.queue?.items)
  const homeDir = useAppStore((store) => store.homeDir)
  const elsewhere = (items ?? []).filter(
    (item) => holdsFolder(item) && item.saveDir && item.saveDir !== destinationDir
  )

  const handleBrowse = async (): Promise<void> => {
    if (destinationDir === undefined) return
    const chosen = await window.plexo.chooseDestinationFolder(destinationDir)
    if (chosen) await window.plexo.queueCommand({ kind: 'setDestination', dir: chosen })
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex h-8 items-center gap-[9px] rounded-[8px] border-[0.5px] border-border px-2.5">
        <div className="shrink-0 font-mono text-[10px] leading-none tracking-[0.14em] text-muted-foreground uppercase">
          Save to
        </div>
        <div className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--text-secondary)]">
          {destinationDir ? toDisplayPath(destinationDir, homeDir) : ''}
        </div>
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={handleBrowse}
          className="h-auto shrink-0 px-0 font-mono text-[11px]"
        >
          Browse…
        </Button>
      </div>
      {elsewhere.length > 0 && (
        <p className="font-sans text-[11px] leading-[1.45] text-muted-foreground">
          {elsewhere.length === 1
            ? `${nameOf(elsewhere[0])} has already started, so it finishes in ${toDisplayPath(elsewhere[0].saveDir!, homeDir)}.`
            : `${elsewhere.length} files have already started, so they finish in the folder they started in.`}{' '}
          New files go to the folder above.
        </p>
      )}
    </div>
  )
}
