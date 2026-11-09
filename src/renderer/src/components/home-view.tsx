import { AlertCircleIcon, LockIcon } from 'lucide-react'
import type { RecordingState } from '@shared/types'
import type { View } from '@/App'
import { RecordButton } from '@/components/record-button'
import { Button } from '@/components/ui/button'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useModelStatus, usePermissions, useSettings } from '@/hooks/use-oatmeal'
import { machine } from '@/lib/utils'

export function HomeView({ onNavigate, recording }: { onNavigate: (v: View) => void; recording: RecordingState }) {
  const { status } = useModelStatus()
  const { permissions } = usePermissions()
  const { settings } = useSettings()
  const llmReady = settings?.llmProvider === 'endpoint' ? !!settings.endpointModel : !!status?.llm.installed
  const llmDownload = status?.downloads.llm
  const llmDownloading = !!llmDownload && !llmDownload.done && !llmDownload.error
  // Onboarding covered setup. This only catches what broke since: a revoked permission, a deleted model.
  const missing = [
    status && !status.asr.installed && 'the speech model',
    permissions && permissions.microphone !== 'granted' && permissions.microphone !== 'unknown' && 'microphone access',
    permissions && permissions.systemAudio !== 'granted' && permissions.systemAudio !== 'unknown' && 'system audio access',
  ].filter(Boolean) as string[]

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

        {missing.length > 0 ? (
          <Alert>
            <AlertCircleIcon />
            <AlertTitle>Oatmeal can’t record right now</AlertTitle>
            <AlertDescription>It needs {missing.join(' and ')}.</AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={() => onNavigate({ kind: 'settings' })}>
                Open Settings
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <div className="space-y-3">
            <RecordButton recording={recording} size="lg" className="w-fit" />
            {status && !llmReady && (
              <p className="text-sm text-muted-foreground">
                {llmDownloading && llmDownload.total
                  ? `Downloading the notes model… ${Math.round((llmDownload.loaded / llmDownload.total) * 100)}%. Calls you record meanwhile get their notes when it’s done.`
                  : llmDownloading
                    ? 'Downloading the notes model…'
                    : 'No notes model yet, so calls are transcribed without notes. '}
                {!llmDownloading && (
                  <Button variant="link" className="h-auto p-0" onClick={() => onNavigate({ kind: 'settings' })}>
                    Set one up
                  </Button>
                )}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
