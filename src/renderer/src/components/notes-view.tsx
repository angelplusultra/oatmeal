import { AlertCircleIcon, Loader2Icon, LockIcon, SparklesIcon } from 'lucide-react'
import { formatTimestamp } from '@shared/transcript'
import type { Meeting, MeetingSummary } from '@shared/types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useSummaryProgress } from '@/hooks/use-oatmeal'
import { machine } from '@/lib/utils'

function Timestamp({ ms, onJump }: { ms: number | null; onJump: (ms: number) => void }) {
  if (ms === null) return null
  return (
    <button
      onClick={() => onJump(ms)}
      className="ml-1.5 rounded px-1 font-mono text-xs text-muted-foreground tabular-nums hover:bg-muted hover:text-foreground"
      title="Show in transcript"
    >
      {formatTimestamp(ms)}
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-heading text-[15px] font-medium text-muted-foreground italic">{title}</h2>
      {children}
    </section>
  )
}

/** A list with honey em-dash bullets. */
function DashList({ children }: { children: React.ReactNode }) {
  return <ul className="space-y-1.5 text-sm leading-relaxed">{children}</ul>
}

function Dash({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="shrink-0 text-brand-text">—</span>
      <span className="min-w-0">{children}</span>
    </li>
  )
}

function Summary({ meeting, summary, onJump }: { meeting: Meeting; summary: MeetingSummary; onJump: (ms: number) => void }) {
  return (
    <div className="space-y-8">
      {summary.tldr && <p className="font-heading text-[19px] leading-[1.55] text-pretty">{summary.tldr}</p>}

      {summary.actionItems.length > 0 && (
        <Section title="Action items">
          <ul className="space-y-2">
            {summary.actionItems.map((item, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <Checkbox
                  className="mt-0.5"
                  checked={item.done}
                  onCheckedChange={(v) => void window.oatmeal.setActionItemDone(meeting.id, i, v === true)}
                />
                <div className="min-w-0 text-sm leading-relaxed">
                  <span className={item.done ? 'text-muted-foreground line-through' : ''}>{item.task}</span>
                  {item.owner && (
                    <Badge variant="secondary" className="ml-2">
                      {item.owner}
                    </Badge>
                  )}
                  {item.due && <span className="ml-2 text-xs text-muted-foreground">due {item.due}</span>}
                  <Timestamp ms={item.ts} onJump={onJump} />
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {summary.decisions.length > 0 && (
        <Section title="Decisions">
          <DashList>
            {summary.decisions.map((d, i) => (
              <Dash key={i}>
                {d.text}
                <Timestamp ms={d.ts} onJump={onJump} />
              </Dash>
            ))}
          </DashList>
        </Section>
      )}

      {summary.keyPoints.length > 0 && (
        <Section title="Key points">
          <div className="space-y-4">
            {summary.keyPoints.map((group, i) => (
              <div key={i}>
                <h3 className="mb-1 text-sm font-medium">{group.topic}</h3>
                <DashList>
                  {group.points.map((p, j) => (
                    <Dash key={j}>{p}</Dash>
                  ))}
                </DashList>
              </div>
            ))}
          </div>
        </Section>
      )}

      {summary.openQuestions.length > 0 && (
        <Section title="Open questions">
          <DashList>
            {summary.openQuestions.map((q, i) => (
              <Dash key={i}>{q}</Dash>
            ))}
          </DashList>
        </Section>
      )}

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LockIcon className="size-3 shrink-0" strokeWidth={2.4} />
        Written by {summary.model} on this {machine} · {new Date(summary.generatedAt).toLocaleString()}
      </p>
    </div>
  )
}

function WritingNotes({ meetingId }: { meetingId: string }) {
  const progress = useSummaryProgress(meetingId)
  let label = 'Getting ready…'
  let value = 5
  if (progress?.stage === 'loading') label = 'Loading the notes model…'
  if (progress?.stage === 'map') {
    label = progress.total > 1 ? `Reading the transcript (part ${Math.min(progress.done + 1, progress.total)} of ${progress.total})…` : 'Reading the transcript…'
    value = 10 + (progress.done / Math.max(progress.total, 1)) * 70
  }
  if (progress?.stage === 'reduce') {
    label = 'Writing the notes…'
    value = 85
  }
  return (
    <div className="space-y-3 py-6">
      <div className="flex items-center gap-2 text-sm">
        <Loader2Icon className="size-4 animate-spin" />
        {label}
      </div>
      <Progress value={value} className="max-w-sm" />
    </div>
  )
}

export function NotesView({ meeting, isLive, onJump }: { meeting: Meeting; isLive: boolean; onJump: (ms: number) => void }) {
  const writeNotes = () => void window.oatmeal.generateNotes(meeting.id)
  let body: React.ReactNode
  if (isLive || meeting.status === 'recording') {
    body = <p className="py-6 text-sm text-muted-foreground">Notes will be written when the call ends. Follow along in the Transcript tab.</p>
  } else if (meeting.status === 'summarizing') {
    body = <WritingNotes meetingId={meeting.id} />
  } else {
    body = (
      <div className="space-y-6">
        {meeting.error && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>No notes yet</AlertTitle>
            <AlertDescription>
              <p>{meeting.error}</p>
              <p>The full transcript is saved.</p>
            </AlertDescription>
          </Alert>
        )}
        {meeting.summary ? (
          <Summary meeting={meeting} summary={meeting.summary} onJump={onJump} />
        ) : (
          <div className="space-y-3 py-6">
            {!meeting.error && <p className="text-sm text-muted-foreground">No notes have been written for this meeting yet.</p>}
            <Button onClick={writeNotes}>
              <SparklesIcon /> Write notes
            </Button>
          </div>
        )}
        {meeting.error && meeting.summary && (
          <Button variant="outline" onClick={writeNotes}>
            Try again
          </Button>
        )}
      </div>
    )
  }
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8">{body}</div>
    </ScrollArea>
  )
}
