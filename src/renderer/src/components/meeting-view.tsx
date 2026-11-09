import type { ExportFormat } from '@shared/api'
import type { RecordingState } from '@shared/types'
import { CopyIcon, DownloadIcon, Loader2Icon, MoreHorizontalIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { View } from '@/App'
import { NotesView } from '@/components/notes-view'
import { TranscriptView } from '@/components/transcript-view'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEvent, useMeeting, useNow } from '@/hooks/use-oatmeal'
import { formatClock, formatDate, formatDuration, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Underline tabs that sit on the header's bottom border. */
const TAB =
  'h-auto flex-none px-0 pt-0 pb-2.5 text-[13.5px] group-data-horizontal/tabs:after:bottom-[-1px] group-data-horizontal/tabs:after:h-[2px]'

const run = (promise: Promise<unknown>, success?: string) =>
  promise.then(
    () => success && toast.success(success),
    (error: Error) => toast.error(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')),
  )

/** While recording: level bars that move when someone is talking, the elapsed time, and Stop. */
function LiveControl({ recording }: { recording: RecordingState }) {
  const now = useNow(recording.kind === 'recording')
  const [speaking, setSpeaking] = useState({ mic: false, system: false })
  useEvent('activity', ({ channel, active }) => setSpeaking((s) => ({ ...s, [channel]: active })))
  const active = speaking.mic || speaking.system
  return (
    <div className="flex h-9 items-center gap-2.5 rounded-lg border bg-card pr-1.5 pl-3 shadow-card">
      <div className="flex h-4 items-center gap-0.5" aria-hidden>
        {[6, 12, 16, 9, 5].map((h, i) => (
          <span
            key={i}
            className={cn(
              'w-[3px] origin-center rounded-full bg-live',
              active && 'animate-[oatmeal-level_0.9s_ease-in-out_infinite]',
            )}
            style={{ height: h, animationDelay: `${i * 120}ms` }}
          />
        ))}
      </div>
      <span className="font-mono text-[12.5px] tabular-nums">
        {recording.kind === 'recording' ? formatClock(now - recording.startedAt) : '0:00'}
      </span>
      <Button
        size="sm"
        className="bg-live text-white hover:bg-live/85"
        disabled={recording.kind !== 'recording'}
        onClick={() => void window.oatmeal.stopRecording()}
      >
        {recording.kind === 'starting' && <Loader2Icon className="animate-spin" />}
        Stop
      </Button>
    </div>
  )
}

export function MeetingView({
  meetingId,
  recording,
  onNavigate,
}: {
  meetingId: string
  recording: RecordingState
  onNavigate: (v: View) => void
}) {
  const { meeting, segments } = useMeeting(meetingId)
  const isLive = (recording.kind === 'recording' || recording.kind === 'starting') && recording.meetingId === meetingId
  const [tab, setTab] = useState<string | null>(null)
  const [jumpTo, setJumpTo] = useState<{ ms: number; at: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (meeting && !editing) setTitle(meeting.title)
  }, [meeting, editing])

  // When the call ends, switch to the notes (they're being written now), even if the transcript was open.
  const wasLive = useRef(isLive)
  useEffect(() => {
    if (wasLive.current && !isLive) setTab('notes')
    wasLive.current = isLive
  }, [isLive])

  if (!meeting) return <div className="h-3 mac:h-12 [-webkit-app-region:drag]" />

  const activeTab = tab ?? (isLive || meeting.status === 'recording' ? 'transcript' : 'notes')
  const exportAs = (format: ExportFormat) => run(window.oatmeal.exportMeeting(meetingId, format))
  const saveTitle = () => {
    setEditing(false)
    if (title.trim() && title !== meeting.title) void run(window.oatmeal.renameMeeting(meetingId, title))
  }

  return (
    <Tabs value={activeTab} onValueChange={setTab} className="flex h-full min-h-0 flex-col gap-0">
      <header className="shrink-0 border-b px-4 pt-5 sm:px-8 mac:pt-11 [-webkit-app-region:drag]">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 [-webkit-app-region:no-drag]">
            {editing ? (
              <Input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveTitle()
                  if (e.key === 'Escape') {
                    setTitle(meeting.title)
                    setEditing(false)
                  }
                }}
                className="h-10 font-heading text-[28px] font-medium tracking-[-0.01em] md:text-[28px]"
              />
            ) : (
              <h1
                className="cursor-text truncate font-heading text-[28px] leading-tight font-medium tracking-[-0.01em]"
                title="Click to rename"
                onClick={() => setEditing(true)}
              >
                {meeting.title}
              </h1>
            )}
            <p className="mt-1 text-sm text-muted-foreground">
              {formatDate(meeting.startedAt)} · {formatTime(meeting.startedAt)}
              {meeting.endedAt ? ` · ${formatDuration(meeting.endedAt - meeting.startedAt)}` : ''}
              {meeting.sourceApp ? ` · ${meeting.sourceApp}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
            {isLive ? (
              <LiveControl recording={recording} />
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Meeting actions">
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem
                    disabled={!meeting.summary}
                    onClick={() => run(window.oatmeal.copyNotes(meetingId), 'Notes copied as Markdown')}
                  >
                    <CopyIcon /> Copy notes
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <DownloadIcon /> Export
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem disabled={!meeting.summary} onClick={() => exportAs('notes-md')}>
                        Notes (.md)
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => exportAs('transcript-txt')}>Transcript (.txt)</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => exportAs('transcript-md')}>Transcript (.md)</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => exportAs('transcript-json')}>
                        Transcript (.json)
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuItem
                    disabled={meeting.status === 'summarizing'}
                    onClick={() => {
                      setTab('notes')
                      void run(window.oatmeal.generateNotes(meetingId))
                    }}
                  >
                    <RefreshCwIcon /> {meeting.summary ? 'Regenerate notes' : 'Write notes'}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => {
                      if (!confirm(`Delete "${meeting.title}" and its transcript? This can't be undone.`)) return
                      void run(window.oatmeal.deleteMeeting(meetingId)).then(() => onNavigate({ kind: 'home' }))
                    }}
                  >
                    <Trash2Icon /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        <TabsList variant="line" className="mt-4 h-auto gap-5 p-0 [-webkit-app-region:no-drag]">
          <TabsTrigger value="notes" className={TAB}>
            Notes
          </TabsTrigger>
          <TabsTrigger value="transcript" className={TAB}>
            Transcript
          </TabsTrigger>
        </TabsList>
      </header>
      <TabsContent value="notes" className="min-h-0 flex-1">
        <NotesView
          meeting={meeting}
          isLive={isLive}
          onJump={(ms) => {
            setTab('transcript')
            setJumpTo({ ms, at: Date.now() })
          }}
        />
      </TabsContent>
      <TabsContent value="transcript" className="min-h-0 flex-1">
        <TranscriptView meeting={meeting} segments={segments} isLive={isLive} jumpTo={jumpTo} />
      </TabsContent>
    </Tabs>
  )
}
