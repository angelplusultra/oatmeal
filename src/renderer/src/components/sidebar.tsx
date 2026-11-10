import type { MeetingListItem, RecordingState } from '@shared/types'
import { SearchIcon, SettingsIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { View } from '@/App'
import { RecordButton } from '@/components/record-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useMeetings } from '@/hooks/use-oatmeal'
import { formatDay, formatDuration, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'

function StatusBadge({ item }: { item: MeetingListItem }) {
  switch (item.status) {
    case 'recording':
      return (
        <span className="flex items-center gap-1 font-medium text-live">
          <span className="size-1.5 rounded-full bg-live" />
          Live
        </span>
      )
    case 'summarizing':
      return <Badge variant="secondary">Writing notes…</Badge>
    case 'failed':
      return <Badge variant="outline">Notes failed</Badge>
    case 'transcribed':
      return <Badge variant="outline">No notes</Badge>
    default:
      return null
  }
}

export function Sidebar({
  view,
  onNavigate,
  recording,
  className,
}: {
  view: View
  onNavigate: (v: View) => void
  recording: RecordingState
  className?: string
}) {
  const [query, setQuery] = useState('')
  const meetings = useMeetings(query)
  const groups = useMemo(() => {
    const out: { day: string; items: MeetingListItem[] }[] = []
    for (const m of meetings) {
      const day = formatDay(m.startedAt)
      if (out.at(-1)?.day !== day) out.push({ day, items: [] })
      out.at(-1)!.items.push(m)
    }
    return out
  }, [meetings])

  return (
    <aside className={cn('flex w-72 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground', className)}>
      {/* Space for the macOS traffic lights; draggable like a title bar. */}
      <div className="h-3 shrink-0 mac:h-12 [-webkit-app-region:drag]" />
      <div className="space-y-2 px-3 pb-3">
        <RecordButton recording={recording} className="w-full" />
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search meetings"
            className="h-8 pl-8"
          />
        </div>
      </div>
      {/* Radix's viewport wraps content in a table-display div that grows with long titles; force block so rows truncate. */}
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <nav className="px-2 pb-3">
          {groups.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {query ? 'No matching meetings.' : 'Your meetings will show up here.'}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.day} className="mb-2">
              <div className="px-2 pt-2.5 pb-1 font-heading text-[15px] text-muted-foreground italic">{group.day}</div>
              {group.items.map((m) => {
                const active = view.kind === 'meeting' && view.id === m.id
                return (
                  <button
                    key={m.id}
                    onClick={() => onNavigate({ kind: 'meeting', id: m.id })}
                    className={cn(
                      'flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent',
                      active && 'bg-sidebar-accent text-sidebar-accent-foreground',
                    )}
                  >
                    <span className="truncate text-sm font-medium">{m.title}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="truncate">
                        {formatTime(m.startedAt)}
                        {m.endedAt ? ` · ${formatDuration(m.endedAt - m.startedAt)}` : ''}
                        {m.sourceApp ? ` · ${m.sourceApp}` : ''}
                      </span>
                      <span className="ml-auto shrink-0">
                        <StatusBadge item={m} />
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
      </ScrollArea>
      <div className="flex gap-1 border-t p-2">
        <Button
          variant="ghost"
          className={cn('flex-1 justify-start', view.kind === 'settings' && 'bg-sidebar-accent')}
          onClick={() => onNavigate({ kind: 'settings' })}
        >
          <SettingsIcon />
          Settings
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="Oatmeal on GitHub"
          aria-label="Oatmeal on GitHub"
          onClick={() => void window.oatmeal.openLink('repo')}
        >
          {/* Lucide dropped brand icons; this is the GitHub mark. */}
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.2.8.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1 .9 2.2v3.3c0 .3.1.7.8.6A12 12 0 0 0 12 .3" />
          </svg>
        </Button>
      </div>
    </aside>
  )
}
