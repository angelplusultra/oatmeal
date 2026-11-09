import type { RecordingState } from '@shared/types'
import { Loader2Icon, MicIcon, SquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-oatmeal'
import { formatClock } from '@/lib/format'
import { cn } from '@/lib/utils'

export function RecordButton({
  recording,
  className,
  size = 'default',
}: {
  recording: RecordingState
  className?: string
  size?: 'default' | 'lg'
}) {
  const now = useNow(recording.kind === 'recording')
  if (recording.kind === 'recording') {
    return (
      <Button
        size={size}
        className={cn('justify-start bg-live-soft text-live hover:bg-live-soft/70', className)}
        onClick={() => void window.oatmeal.stopRecording()}
      >
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-live opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-live" />
        </span>
        Stop recording
        <span className="ml-auto flex items-center gap-2 font-mono text-xs tabular-nums">
          {formatClock(now - recording.startedAt)}
          <SquareIcon className="size-3 fill-current" />
        </span>
      </Button>
    )
  }
  const busy = recording.kind === 'starting' || recording.kind === 'stopping'
  return (
    <Button
      size={size}
      className={cn('justify-start', className)}
      disabled={busy}
      onClick={() => void window.oatmeal.startRecording()}
    >
      {busy ? <Loader2Icon className="animate-spin" /> : <MicIcon />}
      {recording.kind === 'stopping' ? 'Finishing…' : recording.kind === 'starting' ? 'Starting…' : 'Start recording'}
    </Button>
  )
}
