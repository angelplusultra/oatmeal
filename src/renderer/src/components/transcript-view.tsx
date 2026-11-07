import { useEffect, useMemo, useRef, useState } from 'react'
import { formatTimestamp, speakerLabel } from '@shared/transcript'
import type { Channel, Meeting, Segment } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useEvent } from '@/hooks/use-oatmeal'
import { speakerColor } from '@/lib/format'
import { cn } from '@/lib/utils'

interface Block {
  speaker: string
  segments: Segment[]
}

function SpeakerName({ meeting, speaker }: { meeting: Meeting; speaker: string }) {
  const label = speakerLabel(speaker, meeting.speakerNames)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(label)
  const save = () => {
    setOpen(false)
    void window.oatmeal.renameSpeaker(meeting.id, speaker, name)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setName(meeting.speakerNames[speaker] ?? '')
      }}
    >
      <PopoverTrigger asChild>
        <button className={cn('text-sm font-semibold hover:underline', speakerColor(speaker))} title="Rename speaker">
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <p className="text-xs text-muted-foreground">Rename “{label}” everywhere in this meeting.</p>
          <Input autoFocus value={name} placeholder={speakerLabel(speaker)} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" size="sm">
            Save
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}

function SpeakingIndicator({ who }: { who: string }) {
  return (
    <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
      <span className="flex gap-1">
        {[0, 150, 300].map((delay) => (
          <span key={delay} className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70" style={{ animationDelay: `${delay}ms` }} />
        ))}
      </span>
      {who}
    </div>
  )
}

export function TranscriptView({
  meeting,
  segments,
  isLive,
  jumpTo,
}: {
  meeting: Meeting
  segments: Segment[]
  isLive: boolean
  jumpTo: { ms: number; at: number } | null
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [highlight, setHighlight] = useState<number | null>(null)
  const [activity, setActivity] = useState<Record<Channel, boolean>>({ mic: false, system: false })
  useEvent('activity', ({ channel, active }) => setActivity((a) => ({ ...a, [channel]: active })))

  const blocks = useMemo(() => {
    const out: Block[] = []
    for (const s of segments) {
      if (s.echo || !s.text.trim()) continue
      const last = out.at(-1)
      if (last && last.speaker === s.speaker && s.startMs - last.segments.at(-1)!.endMs < 8000) last.segments.push(s)
      else out.push({ speaker: s.speaker, segments: [s] })
    }
    return out
  }, [segments])

  // Follow new lines while live, unless the user scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current
    if (el && isLive && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [blocks, isLive, activity])

  useEffect(() => {
    if (!jumpTo || !scrollRef.current) return
    const target = segments.find((s) => !s.echo && s.endMs >= jumpTo.ms - 500)
    if (!target) return
    const el = scrollRef.current.querySelector(`[data-segment="${target.id}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setHighlight(target.id)
    const timer = setTimeout(() => setHighlight(null), 2500)
    return () => clearTimeout(timer)
  }, [jumpTo, segments])

  const someoneSpeaking = isLive && (activity.mic || activity.system)

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
    >
      <div className="mx-auto max-w-3xl space-y-5 px-8 py-6">
        {blocks.length === 0 && !someoneSpeaking && (
          <p className="py-6 text-sm text-muted-foreground">
            {isLive ? 'Listening… Each sentence appears here a moment after it’s spoken.' : 'Nothing was transcribed in this meeting.'}
          </p>
        )}
        {blocks.map((block) => (
          <div key={block.segments[0].id} className="space-y-1">
            <div className="flex items-baseline gap-2">
              <SpeakerName meeting={meeting} speaker={block.speaker} />
              <span className="font-mono text-xs text-muted-foreground tabular-nums">{formatTimestamp(block.segments[0].startMs)}</span>
            </div>
            <p className="text-sm leading-relaxed">
              {block.segments.map((s) => (
                <span
                  key={s.id}
                  data-segment={s.id}
                  className={cn('rounded transition-colors duration-700', highlight === s.id && 'bg-yellow-200/70 dark:bg-yellow-500/30')}
                >
                  {s.text}{' '}
                </span>
              ))}
            </p>
          </div>
        ))}
        {someoneSpeaking && <SpeakingIndicator who={activity.mic && activity.system ? 'Both sides are talking…' : activity.mic ? 'You’re talking…' : 'Others are talking…'} />}
      </div>
    </div>
  )
}
