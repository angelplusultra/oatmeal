import { CheckCircle2Icon, DownloadIcon, FileIcon, FolderOpenIcon, Loader2Icon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ASR_MODELS, LLM_MODELS, asrModel, llmModel } from '@shared/models'
import type { ModelKind, ModelStatus, PermissionState, Settings } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useModelStatus, usePermissions, useSettings } from '@/hooks/use-oatmeal'
import { formatBytes } from '@/lib/format'
import { isMac, machine } from '@/lib/utils'

function Row({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
      <div className="min-w-0 space-y-0.5">
        <Label className="text-sm font-medium">{title}</Label>
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

function ModelDownload({ kind, installed, sizeLabel, status }: { kind: ModelKind; installed: boolean; sizeLabel: string; status: ModelStatus | null }) {
  const download = status?.download?.kind === kind ? status.download : null
  const running = !!download && !download.done && !download.error
  if (installed && !running) {
    return (
      <Badge variant="secondary">
        <CheckCircle2Icon className="text-emerald-600" /> Downloaded
      </Badge>
    )
  }
  if (running) {
    const pct = download.total ? Math.round((download.loaded / download.total) * 100) : null
    return (
      <div className="flex w-56 items-center gap-2">
        <Progress value={pct ?? 0} className="flex-1" />
        <span className="w-24 text-right text-xs text-muted-foreground tabular-nums">
          {pct !== null ? `${pct}%` : formatBytes(download.loaded)}
        </span>
        {kind === 'llm' && (
          <Button variant="ghost" size="icon-sm" aria-label="Cancel download" onClick={() => void window.oatmeal.cancelDownload()}>
            <XIcon />
          </Button>
        )}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      {download?.error && <span className="max-w-48 truncate text-xs text-destructive" title={download.error}>{download.error}</span>}
      <Button
        size="sm"
        variant="outline"
        onClick={() => void window.oatmeal.downloadModel(kind).catch((e: Error) => toast.error(e.message))}
      >
        <DownloadIcon /> Download {sizeLabel}
      </Button>
    </div>
  )
}

const PERMISSION_LABEL: Record<PermissionState, string> = {
  granted: 'Allowed',
  denied: 'Denied',
  'not-determined': 'Not asked yet',
  restricted: 'Restricted',
  unknown: 'Unknown',
}

function PermissionRow({ kind, state, onRequest }: { kind: 'microphone' | 'systemAudio'; state: PermissionState | undefined; onRequest: () => void }) {
  const title = kind === 'microphone' ? 'Microphone' : 'System audio recording'
  const description = kind === 'microphone' ? 'To transcribe what you say.' : 'To transcribe the other people on the call. Oatmeal never records your screen.'
  return (
    <Row title={title} description={description}>
      <Badge variant={state === 'granted' ? 'secondary' : 'outline'}>
        {state === 'granted' && <CheckCircle2Icon className="text-emerald-600" />}
        {state ? PERMISSION_LABEL[state] : '…'}
      </Badge>
      {state !== 'granted' &&
        (state === 'not-determined' ? (
          <Button size="sm" variant="outline" onClick={onRequest}>
            Allow
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => void window.oatmeal.openPermissionSettings(kind)}>
            Open System Settings
          </Button>
        ))}
    </Row>
  )
}

/** Where the built-in notes model comes from: a GGUF on disk (found or chosen), or Oatmeal's own download. */
function LocalModelSource({ settings, status, set }: { settings: Settings; status: ModelStatus | null; set: (p: Partial<Settings>) => void }) {
  const llm = llmModel(settings.localModel)
  const found = status?.llm.found[0]
  const choose = () =>
    void window.oatmeal
      .chooseModelFile()
      .then((file) => file && set({ localModelPath: file }))
      .catch((e: Error) => toast.error(e.message))
  const chooseButton = (
    <Button size="sm" variant="ghost" onClick={choose}>
      <FileIcon /> Use another GGUF…
    </Button>
  )

  if (settings.localModelPath) {
    return (
      <Row
        title="Model file"
        description={
          <>
            <span className="break-all">{settings.localModelPath}</span>
            {status && !status.llm.installed && <span className="block text-destructive">This file is missing.</span>}
          </>
        }
      >
        {chooseButton}
        <Button size="sm" variant="outline" onClick={() => set({ localModelPath: '' })}>
          Use Oatmeal's {llm.name}
        </Button>
      </Row>
    )
  }
  if (found && !status?.llm.installed && status?.download?.kind !== 'llm') {
    return (
      <Row
        title={`Found ${llm.name} from ${found.source}`}
        description={<span className="break-all">{found.path}</span>}
      >
        {chooseButton}
        <Button size="sm" onClick={() => set({ localModelPath: found.path })}>
          Use this file
        </Button>
        <ModelDownload kind="llm" installed={false} sizeLabel={`(${formatBytes(llm.sizeBytes)})`} status={status} />
      </Row>
    )
  }
  return (
    <Row title="" description={null}>
      {chooseButton}
      <ModelDownload kind="llm" installed={!!status?.llm.installed} sizeLabel={`(${formatBytes(llm.sizeBytes)})`} status={status} />
    </Row>
  )
}

function EndpointFields({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const [draft, setDraft] = useState({ url: settings.endpointUrl, model: settings.endpointModel, key: settings.endpointApiKey })
  const commit = () => update({ endpointUrl: draft.url.trim(), endpointModel: draft.model.trim(), endpointApiKey: draft.key })
  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="endpoint-url">Server URL</Label>
        <Input id="endpoint-url" value={draft.url} placeholder="http://localhost:11434/v1" onChange={(e) => setDraft({ ...draft, url: e.target.value })} onBlur={commit} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="endpoint-model">Model</Label>
        <Input id="endpoint-model" value={draft.model} placeholder="gemma4:e4b" onChange={(e) => setDraft({ ...draft, model: e.target.value })} onBlur={commit} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="endpoint-key">API key (optional)</Label>
        <Input id="endpoint-key" type="password" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} onBlur={commit} />
      </div>
      <p className="text-xs text-muted-foreground">
        Any OpenAI-compatible server works, e.g. Ollama (which uses MLX on Apple Silicon), LM Studio or llama-server. Keep it on this machine to keep things private.
      </p>
    </div>
  )
}

export function SettingsView() {
  const { settings, update } = useSettings()
  const { status, refresh } = useModelStatus()
  const { permissions, setPermissions } = usePermissions()

  if (!settings) return null
  const asr = asrModel(settings.asrModel)
  const llm = llmModel(settings.localModel)
  const set = (patch: Partial<Settings>) => void update(patch).then(refresh)
  const request = (kind: 'microphone' | 'systemAudio') => void window.oatmeal.requestPermission(kind).then(setPermissions)

  return (
    <ScrollArea className="h-full">
      <div className="h-5 mac:h-12 [-webkit-app-region:drag]" />
      <div className="mx-auto max-w-3xl space-y-6 px-4 pb-12 sm:px-8">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>

        <Card>
          <CardHeader>
            <CardTitle>Transcription</CardTitle>
            <CardDescription>Runs on your {machine} with Moonshine. English only for now.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Row title="Speech model" description={asr.description}>
              <Select value={settings.asrModel} onValueChange={(v) => set({ asrModel: v as Settings['asrModel'] })}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASR_MODELS.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row title="" description={null}>
              <ModelDownload kind="asr" installed={!!status?.asr.installed && !!status.asr.diarizationInstalled} sizeLabel={`(${formatBytes(asr.approxBytes)})`} status={status} />
            </Row>
            <Separator />
            <Row
              title="Separate remote speakers"
              description="Labels the other people as Speaker 1, Speaker 2… Uses about half a CPU core more while they talk. When off, everyone else is “Them”."
            >
              <Switch checked={settings.separateSpeakers} onCheckedChange={(v) => set({ separateSpeakers: v })} />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
            <CardDescription>Written by a local language model after each call.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Row title="Run notes model" description={settings.llmProvider === 'local' ? `Built in, using llama.cpp with ${isMac ? 'Metal' : 'CUDA, Vulkan or the CPU'}.` : 'On a server you run.'}>
              <Select value={settings.llmProvider} onValueChange={(v) => set({ llmProvider: v as Settings['llmProvider'] })}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">On this {machine} (built in)</SelectItem>
                  <SelectItem value="endpoint">OpenAI-compatible server</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            {settings.llmProvider === 'local' ? (
              <>
                <Row title="Model" description={llm.description}>
                  <Select value={settings.localModel} onValueChange={(v) => set({ localModel: v as Settings['localModel'], localModelPath: '' })}>
                    <SelectTrigger className="w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LLM_MODELS.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name} · {formatBytes(m.sizeBytes)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Row>
                <LocalModelSource settings={settings} status={status} set={set} />
              </>
            ) : (
              <EndpointFields settings={settings} update={set} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Meeting detection</CardTitle>
            <CardDescription>Oatmeal notices when a call app starts using your microphone and asks before transcribing.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Row title="Offer to transcribe calls" description="Zoom, Teams, Slack, Discord, FaceTime, Webex, and calls in your browser.">
              <Switch checked={settings.detectionEnabled} onCheckedChange={(v) => set({ detectionEnabled: v })} />
            </Row>
            <Row
              title="Stop when the call ends"
              description="Oatmeal stops ~2 seconds after the call app releases the mic and goes quiet. If it keeps playing audio (for example, you're muted), it stops after this many seconds without anyone talking."
            >
              <Input
                type="number"
                min={5}
                max={300}
                className="w-20"
                defaultValue={settings.autoStopSeconds}
                onBlur={(e) => set({ autoStopSeconds: Math.min(300, Math.max(5, Number(e.target.value) || 15)) })}
              />
            </Row>
            {settings.ignoredApps.length > 0 && (
              <Row title="Never ask for" description="Remove an app to be asked again.">
                <div className="flex max-w-80 flex-wrap justify-end gap-1.5">
                  {settings.ignoredApps.map((name) => (
                    <Badge key={name} variant="outline" className="gap-1 pr-1">
                      {name}
                      <button aria-label={`Ask again for ${name}`} onClick={() => set({ ignoredApps: settings.ignoredApps.filter((a) => a !== name) })}>
                        <XIcon className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </Row>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Permissions</CardTitle>
            <CardDescription>
              {!isMac
                ? permissions && !permissions.helperAvailable
                  ? 'Oatmeal records through PipeWire. Install pipewire-pulse (for pactl) and pipewire (for pw-record).'
                  : 'Linux needs no permission for audio. Oatmeal records through PipeWire.'
                : permissions && !permissions.helperAvailable
                  ? 'The audio helper is missing. Run `npm run setup`.'
                  : 'macOS asks once. If you denied access, turn it on in System Settings.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <PermissionRow kind="microphone" state={permissions?.microphone} onRequest={() => request('microphone')} />
            <PermissionRow kind="systemAudio" state={permissions?.systemAudio} onRequest={() => request('systemAudio')} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Your data</CardTitle>
            <CardDescription>
              Transcripts, notes and models are stored only on this {machine}. Audio is never saved. Oatmeal only goes online to download models.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void window.oatmeal.openDataFolder()}>
              <FolderOpenIcon /> Open data folder
            </Button>
          </CardContent>
        </Card>

        {!status && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Checking models…
          </p>
        )}
      </div>
    </ScrollArea>
  )
}
