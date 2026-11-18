import { cn, devBranch } from '@/lib/utils'

/** Marks a build running from source, so it isn't mistaken for the installed app. Renders nothing when installed. */
export function DevBadge({ className }: { className?: string }) {
  if (devBranch === null) return null
  return (
    <span
      title={devBranch ? `Running from source on ${devBranch}` : 'Running from source'}
      className={cn(
        'max-w-40 truncate rounded-sm bg-dev px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-white select-none',
        className,
      )}
    >
      DEV{devBranch && <span className="font-normal opacity-80"> {devBranch}</span>}
    </span>
  )
}
