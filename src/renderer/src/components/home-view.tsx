import { CheckCircle2Icon, CircleIcon, LockIcon } from 'lucide-react'
import type { RecordingState } from '@shared/types'
import type { View } from '@/App'
import { RecordButton } from '@/components/record-button'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useModelStatus, usePermissions, useSettings } from '@/hooks/use-oatmeal'
import { isMac, machine } from '@/lib/utils'

function Step({ done, title, detail }: { done: boolean; title: string; detail: string }) {
  return (
    <li className="flex gap-3">
      {done ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-sm text-muted-foreground">{detail}</div>
      </div>
    </li>
  )
}

export function HomeView({ onNavigate, recording }: { onNavigate: (v: View) => void; recording: RecordingState }) {
  const { status } = useModelStatus()
  const { permissions } = usePermissions()
  const { settings } = useSettings()
  const llmReady = settings?.llmProvider === 'endpoint' ? !!settings.endpointModel : !!status?.llm.installed
  const permissionsReady = permissions?.microphone === 'granted' && permissions?.systemAudio === 'granted'
  const setupDone = !!status?.asr.installed && llmReady

  return (
    <div className="flex h-full flex-col">
      <div className="h-3 shrink-0 mac:h-12 [-webkit-app-region:drag]" />
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-4 pb-16 sm:px-8">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Oatmeal</h1>
          <p className="text-muted-foreground">
            Join a call in Zoom, Meet, Teams, Slack or Discord and Oatmeal will offer to transcribe it. When the call ends, it writes your notes.
          </p>
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <LockIcon className="size-3.5" /> Everything runs on this {machine}. No audio or text ever leaves it.
          </p>
        </div>

        {!setupDone || !permissionsReady ? (
          <Card>
            <CardHeader>
              <CardTitle>Finish setting up</CardTitle>
              <CardDescription>A one-time download of the models{isMac && ', plus two macOS permissions'}.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-3">
                <Step done={!!status?.asr.installed} title="Speech model" detail="Moonshine, for transcription (about 300 MB)." />
                <Step done={llmReady} title="Notes model" detail="Gemma 4, for writing notes (3–5 GB), or your own local server." />
                <Step done={permissionsReady} title="Permissions" detail="Microphone and System Audio Recording." />
              </ul>
              <Button onClick={() => onNavigate({ kind: 'settings' })}>Open setup</Button>
            </CardContent>
          </Card>
        ) : (
          <RecordButton recording={recording} size="lg" className="w-fit" />
        )}
      </div>
    </div>
  )
}
