import { Loader2Icon, MicIcon, SquareIcon } from 'lucide-react'
import type { RecordingState } from '@shared/types'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-oatmeal'
import { formatClock } from '@/lib/format'
import { cn } from '@/lib/utils'

export function RecordButton({ recording, className, size = 'default' }: { recording: RecordingState; className?: string; size?: 'default' | 'lg' }) {
  const now = useNow(recording.kind === 'recording')
  if (recording.kind === 'recording') {
    return (
      <Button variant="destructive" size={size} className={cn('justify-start', className)} onClick={() => void window.oatmeal.stopRecording()}>
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-red-500" />
        </span>
        Stop · {formatClock(now - recording.startedAt)}
        <SquareIcon className="ml-auto size-3.5 fill-current" />
      </Button>
    )
  }
  const busy = recording.kind === 'starting' || recording.kind === 'stopping'
  return (
    <Button size={size} className={cn('justify-start', className)} disabled={busy} onClick={() => void window.oatmeal.startRecording()}>
      {busy ? <Loader2Icon className="animate-spin" /> : <MicIcon />}
      {recording.kind === 'stopping' ? 'Finishing…' : recording.kind === 'starting' ? 'Starting…' : 'Start recording'}
    </Button>
  )
}
