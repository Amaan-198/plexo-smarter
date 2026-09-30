import { holdsFolder, nameOf } from '@shared/queueItem'
import { cn } from 'cn'
import { useAppStore } from '../store/useAppStore'
import { toDisplayPath } from '../utils/format'
import { Button } from './ui/button'

/** The queue's folder, which every item is saved to, and a way to pick another — once no
 * download under way is still bound to this one. */
export function QueueDestination({ className }: { className?: string }): React.JSX.Element {
  const destinationDir = useAppStore((store) => store.queue?.destinationDir)
  const items = useAppStore((store) => store.queue?.items)
  const homeDir = useAppStore((store) => store.homeDir)
  const holding = (items ?? []).filter(holdsFolder)

  const handleBrowse = async (): Promise<void> => {
    if (destinationDir === undefined || holding.length > 0) return
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
          disabled={holding.length > 0}
          onClick={handleBrowse}
          className="h-auto shrink-0 px-0 font-mono text-[11px]"
        >
          Browse…
        </Button>
      </div>
      {holding.length > 0 && (
        <p className="font-sans text-[11px] leading-[1.45] text-muted-foreground">
          {holding.length === 1
            ? `${nameOf(holding[0])} has started in this folder and finishes there.`
            : `${holding.length} files have started in this folder and finish there.`}{' '}
          To pick another folder, let {holding.length === 1 ? 'it' : 'them'} finish, or cancel or
          remove {holding.length === 1 ? 'it' : 'them'}.
        </p>
      )}
    </div>
  )
}
