/**
 * First-run setup, shown in place of the app until it's done: audio access, the two models, and what to
 * expect on the first call. Calls aren't offered until the user finishes (see the orchestrator).
 */

import { asrModel, LLM_MODELS, llmModel } from '@shared/models'
import type {
  DownloadProgress,
  ModelKind,
  ModelStatus,
  PermissionState,
  PermissionStatus,
  Settings,
} from '@shared/types'
import { ArrowLeftIcon, AudioLinesIcon, FileIcon, FileTextIcon, Loader2Icon, MicIcon, Volume2Icon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { DoneMark, PrivacyNote } from '@/components/pantry'
import { EndpointFields } from '@/components/settings-view'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useModelStatus, useOpenAtLogin, usePermissions, useSettings } from '@/hooks/use-oatmeal'
import { formatBytes } from '@/lib/format'
import { cn, isMac, machine } from '@/lib/utils'
import iconUrl from '../../../../assets/icon.svg'

type StepId = 'welcome' | 'permissions' | 'models' | 'ready'

const STEP_LABELS: Record<Exclude<StepId, 'welcome'>, string> = {
  permissions: 'Audio access',
  models: 'Models',
  ready: 'Ready',
}

const running = (d: DownloadProgress | undefined): boolean => !!d && !d.done && !d.error
const percent = (d: DownloadProgress) => (d.total ? Math.round((d.loaded / d.total) * 100) : null)
/** "Unknown" means macOS wouldn't say (no public API for system audio). Don't block on it. */
const permissionOk = (state: PermissionState) => state === 'granted' || state === 'unknown'

function download(kind: ModelKind) {
  void window.oatmeal.downloadModel(kind).catch((e: Error) => toast.error(e.message))
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { settings, update } = useSettings()
  const { status, refresh } = useModelStatus()
  const { permissions, setPermissions } = usePermissions()
  const [index, setIndex] = useState(0)

  if (!settings) return null
  // Linux needs no permissions, so it only gets this step when PipeWire's tools are missing.
  const askPermissions = isMac || (!!permissions && !permissions.helperAvailable)
  const steps: StepId[] = ['welcome', ...(askPermissions ? (['permissions'] as const) : []), 'models', 'ready']
  const step = steps[Math.min(index, steps.length - 1)]
  const next = () => setIndex((i) => Math.min(i + 1, steps.length - 1))
  const back = () => setIndex((i) => Math.max(i - 1, 0))
  const set = (patch: Partial<Settings>) => void update(patch).then(refresh)

  return (
    <ScrollArea className="h-full">
      <div className="h-6 mac:h-12 [-webkit-app-region:drag]" />
      <div className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-lg flex-col justify-center px-4 pb-12 sm:px-0">
        {step !== 'welcome' && (
          <StepHeader steps={steps.slice(1) as Exclude<StepId, 'welcome'>[]} current={index - 1} onBack={back} />
        )}
        <div>
          {step === 'welcome' && <Welcome onNext={next} />}
          {step === 'permissions' && (
            <PermissionsStep permissions={permissions} onChange={setPermissions} onNext={next} />
          )}
          {step === 'models' && <ModelsStep settings={settings} status={status} set={set} onNext={next} />}
          {step === 'ready' && <ReadyStep status={status} settings={settings} onDone={onDone} />}
        </div>
      </div>
    </ScrollArea>
  )
}

function StepHeader({
  steps,
  current,
  onBack,
}: {
  steps: Exclude<StepId, 'welcome'>[]
  current: number
  onBack: () => void
}) {
  return (
    <div className="mb-8 space-y-3">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" className="-ml-2.5 text-muted-foreground" onClick={onBack}>
          <ArrowLeftIcon /> Back
        </Button>
        <span className="font-mono text-[11.5px] text-muted-foreground tabular-nums">
          Step {current + 1} of {steps.length}
        </span>
      </div>
      <ol className="grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((id, i) => (
          <li key={id} className="space-y-1.5">
            <div className={cn('h-1.5 rounded-full', i <= current ? 'bg-brand' : 'bg-track')} />
            <div className={cn('text-xs', i === current ? 'font-medium text-foreground' : 'text-muted-foreground')}>
              {STEP_LABELS[id]}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function StepTitle({ title, description }: { title: string; description: React.ReactNode }) {
  return (
    <div className="mb-6 space-y-2">
      <h1 className="font-heading text-[32px] leading-tight font-medium tracking-[-0.01em]">{title}</h1>
      <p className="text-[15px] leading-relaxed text-pretty text-muted-foreground">{description}</p>
    </div>
  )
}

/** One line in a step's list: an icon, what it is and why, and its state or action on the right. */
function Item({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode
  title: React.ReactNode
  description: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <li className="flex gap-3 p-4">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-text [&_svg]:size-4">
        {icon}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
      {children && <div className="flex shrink-0 items-start">{children}</div>}
    </li>
  )
}

const Done = ({ label }: { label: string }) => (
  <span className="pt-0.5">
    <DoneMark label={label} />
  </span>
)

/** The bordered list the permission and model rows sit in. */
const LIST = 'divide-y rounded-xl border bg-card shadow-card'

// ---------------------------------------------------------------- welcome

const SETUP_STEPS = [
  ...(isMac ? ['Let Oatmeal hear your microphone and your calls.'] : []),
  'Download the speech and notes models (one time).',
  'See what happens on your first call.',
]

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3">
        <img src={iconUrl} alt="" className="-ml-1.5 size-15" />
        <h1 className="font-heading text-[52px] leading-[1.05] font-medium tracking-[-0.01em]">Welcome to Oatmeal</h1>
        <p className="text-[15px] leading-relaxed text-pretty text-muted-foreground">
          Oatmeal transcribes your calls and writes the notes: a summary, decisions, action items and open questions.
        </p>
        <PrivacyNote>Everything runs on this {machine}. Audio is never saved, and nothing is uploaded.</PrivacyNote>
      </div>
      <div className="space-y-3 rounded-xl border bg-card p-5 shadow-card">
        <p className="font-heading text-[15px] font-medium text-muted-foreground italic">Setup takes a few minutes</p>
        <ol className="space-y-2.5 text-sm">
          {SETUP_STEPS.map((text, i) => (
            <li key={text} className="flex items-center gap-3">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-soft font-mono text-[11px] text-brand-text">
                {i + 1}
              </span>
              {text}
            </li>
          ))}
        </ol>
      </div>
      <Button size="lg" onClick={onNext}>
        Get started
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------- permissions

function PermissionsStep({
  permissions,
  onChange,
  onNext,
}: {
  permissions: PermissionStatus | null
  onChange: (p: PermissionStatus) => void
  onNext: () => void
}) {
  if (!permissions) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> Checking permissions…
      </p>
    )
  }
  if (!permissions.helperAvailable) {
    return (
      <>
        <StepTitle
          title={isMac ? 'The audio helper is missing' : 'Install PipeWire’s tools'}
          description={
            isMac
              ? 'Oatmeal records through a small helper that isn’t in this build. Run `npm run setup`, then restart Oatmeal.'
              : 'Oatmeal records through PipeWire. Install pipewire (for pw-record) and pipewire-pulse (for pactl), then check again.'
          }
        />
        <Button onClick={() => void window.oatmeal.getPermissions().then(onChange)}>Check again</Button>
      </>
    )
  }

  const ready = permissionOk(permissions.microphone) && permissionOk(permissions.systemAudio)
  const denied = [permissions.microphone, permissions.systemAudio].some((s) => s === 'denied' || s === 'restricted')
  return (
    <>
      <StepTitle
        title="Let Oatmeal hear your calls"
        description={`macOS asks you to allow two things. Oatmeal turns audio into text on this ${machine} as it arrives, and never saves it.`}
      />
      <ul className={LIST}>
        <PermissionItem
          kind="microphone"
          icon={<MicIcon />}
          title="Microphone"
          description="So what you say is in the transcript."
          state={permissions.microphone}
          onChange={onChange}
        />
        <PermissionItem
          kind="systemAudio"
          icon={<Volume2Icon />}
          title="System audio recording"
          description="So the other people on the call are too. Oatmeal hears the call’s audio. It never sees your screen."
          state={permissions.systemAudio}
          onChange={onChange}
        />
      </ul>
      {denied && (
        <p className="mt-4 text-sm text-muted-foreground">
          macOS only asks once. In System Settings, turn on Oatmeal, then come back here. Without these, calls are
          recorded as silence.
        </p>
      )}
      <Button size="lg" className="mt-8" disabled={!ready} onClick={onNext}>
        Continue
      </Button>
    </>
  )
}

function PermissionItem({
  kind,
  icon,
  title,
  description,
  state,
  onChange,
}: {
  kind: 'microphone' | 'systemAudio'
  icon: React.ReactNode
  title: string
  description: string
  state: PermissionState
  onChange: (p: PermissionStatus) => void
}) {
  const [asking, setAsking] = useState(false)
  const ask = () => {
    setAsking(true)
    void window.oatmeal
      .requestPermission(kind)
      .then(onChange)
      .finally(() => setAsking(false))
  }
  let action: React.ReactNode
  if (state === 'granted') action = <Done label="Allowed" />
  else if (state === 'denied' || state === 'restricted') {
    action = (
      <Button size="sm" variant="outline" onClick={() => void window.oatmeal.openPermissionSettings(kind)}>
        Open System Settings
      </Button>
    )
  } else {
    action = (
      <Button size="sm" disabled={asking} onClick={ask}>
        {asking && <Loader2Icon className="animate-spin" />} Allow
      </Button>
    )
  }
  return (
    <Item icon={icon} title={title} description={description}>
      {action}
    </Item>
  )
}

// ---------------------------------------------------------------- models

/** Right-hand side of a model row: progress while downloading, then "Ready". */
function DownloadState({
  ready,
  download,
  size,
}: {
  ready: boolean
  download: DownloadProgress | undefined
  size: string
}) {
  if (ready && !running(download)) return <Done label="Ready" />
  if (download && running(download)) {
    const pct = percent(download)
    return (
      <div className="flex w-36 items-center gap-2 pt-1.5">
        <Progress value={pct ?? 0} className="flex-1" />
        <span className="w-9 text-right font-mono text-[11.5px] text-muted-foreground tabular-nums">
          {pct !== null ? `${pct}%` : '…'}
        </span>
      </div>
    )
  }
  if (download?.error) {
    return (
      <span className="max-w-36 truncate pt-0.5 text-xs text-destructive" title={download.error}>
        Download failed
      </span>
    )
  }
  return <span className="pt-0.5 font-mono text-[11.5px] text-muted-foreground tabular-nums">{size}</span>
}

function ModelsStep({
  settings,
  status,
  set,
  onNext,
}: {
  settings: Settings
  status: ModelStatus | null
  set: (patch: Partial<Settings>) => void
  onNext: () => void
}) {
  const asr = asrModel(settings.asrModel)
  const llm = llmModel(settings.localModel)
  const asrDownload = status?.downloads.asr
  const llmDownload = status?.downloads.llm
  const usingServer = settings.llmProvider === 'endpoint'
  const speechReady = !!status?.asr.installed && !!status.asr.diarizationInstalled
  const notesReady = usingServer ? !!settings.endpointUrl && !!settings.endpointModel : !!status?.llm.installed
  const fetchSpeech = !speechReady && !running(asrDownload)
  const fetchNotes = !usingServer && !notesReady && !running(llmDownload)
  const bytes = (fetchSpeech ? asr.approxBytes : 0) + (fetchNotes ? llm.sizeBytes : 0)
  const found = !settings.localModelPath && !notesReady ? status?.llm.found[0] : undefined

  const start = () => {
    if (fetchSpeech) download('asr')
    if (fetchNotes) download('llm')
  }
  const chooseFile = () =>
    void window.oatmeal
      .chooseModelFile()
      .then((file) => file && set({ localModelPath: file }))
      .catch((e: Error) => toast.error(e.message))

  const notesName = usingServer
    ? 'Your model server'
    : settings.localModelPath
      ? settings.localModelPath.split('/').pop()
      : llm.name
  const notesChoice = !usingServer && !settings.localModelPath && !notesReady && !running(llmDownload)

  let footer: React.ReactNode
  if (!status) {
    footer = <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
  } else if (speechReady && fetchNotes) {
    footer = (
      <>
        <div className="flex flex-wrap gap-2">
          <Button size="lg" onClick={start}>
            {llmDownload?.error ? 'Try again' : 'Download notes model'} · {formatBytes(bytes)}
          </Button>
          <Button size="lg" variant="outline" onClick={onNext}>
            Skip for now
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Without it, calls are transcribed but get no notes. You can set it up later in Settings.
        </p>
      </>
    )
  } else if (speechReady) {
    footer = (
      <>
        <Button size="lg" onClick={onNext}>
          Continue
        </Button>
        {running(llmDownload) && (
          <p className="text-sm text-muted-foreground">
            The notes model keeps downloading in the background. Calls you record meanwhile get their notes when it’s
            done.
          </p>
        )}
      </>
    )
  } else if (fetchSpeech || fetchNotes) {
    footer = (
      <Button size="lg" onClick={start}>
        {asrDownload?.error || llmDownload?.error ? 'Try again' : 'Download'} · {formatBytes(bytes)}
      </Button>
    )
  } else {
    footer = (
      <>
        <Button size="lg" disabled>
          <Loader2Icon className="animate-spin" /> Downloading the speech model…
        </Button>
        <p className="text-sm text-muted-foreground">You can continue as soon as the speech model is ready.</p>
      </>
    )
  }

  return (
    <>
      <StepTitle
        title="Download the models"
        description={`Two AI models run on this ${machine}: one to transcribe, one to write notes. They download once.`}
      />
      <ul className={LIST}>
        <Item
          icon={<AudioLinesIcon />}
          title="Speech model"
          description={`${asr.name}. Turns what’s said into text as the call happens.`}
        >
          <DownloadState ready={speechReady} download={asrDownload} size={formatBytes(asr.approxBytes)} />
        </Item>
        <Item
          icon={<FileTextIcon />}
          title="Notes model"
          description={
            <>
              {notesChoice ? 'Writes' : `${notesName}. Writes`} the summary, decisions and action items after each call.
              {notesChoice && (
                <span className="mt-3 block space-y-3">
                  <Select
                    value={settings.localModel}
                    onValueChange={(v) => set({ localModel: v as Settings['localModel'] })}
                  >
                    <SelectTrigger className="w-full">
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
                  <span className="block text-xs">{llm.description}</span>
                  {found && (
                    <span className="flex flex-wrap items-center gap-x-2 text-sm">
                      You already have it from {found.source}.
                      <Button
                        size="sm"
                        variant="link"
                        className="h-auto px-0"
                        onClick={() => set({ localModelPath: found.path })}
                      >
                        Use that copy
                      </Button>
                    </span>
                  )}
                </span>
              )}
            </>
          }
        >
          {usingServer ? (
            notesReady ? (
              <Done label="Set" />
            ) : null
          ) : (
            <DownloadState ready={notesReady} download={llmDownload} size={formatBytes(llm.sizeBytes)} />
          )}
        </Item>
      </ul>

      {usingServer && (
        <div className="mt-4 rounded-xl border bg-card p-4 shadow-card">
          <EndpointFields settings={settings} update={set} />
        </div>
      )}
      {!running(llmDownload) && (
        <div className="mt-2 flex flex-wrap gap-x-4 text-sm">
          {usingServer || settings.localModelPath ? (
            <Button
              variant="link"
              size="sm"
              className="px-0 text-muted-foreground"
              onClick={() => set({ llmProvider: 'local', localModelPath: '' })}
            >
              Download Oatmeal’s notes model instead
            </Button>
          ) : (
            <>
              <Button variant="link" size="sm" className="px-0 text-muted-foreground" onClick={chooseFile}>
                <FileIcon /> Use a GGUF file I have
              </Button>
              <Button
                variant="link"
                size="sm"
                className="px-0 text-muted-foreground"
                onClick={() => set({ llmProvider: 'endpoint' })}
              >
                Use Ollama or LM Studio
              </Button>
            </>
          )}
        </div>
      )}

      <div className="mt-8 space-y-3">{footer}</div>
    </>
  )
}

// ---------------------------------------------------------------- ready

function ReadyStep({
  status,
  settings,
  onDone,
}: {
  status: ModelStatus | null
  settings: Settings
  onDone: () => void
}) {
  const [openAtLogin, setOpenAtLogin] = useOpenAtLogin()
  const [wantLogin, setWantLogin] = useState(true)
  const llmDownload = status?.downloads.llm
  const notesReady = settings.llmProvider === 'endpoint' ? !!settings.endpointModel : !!status?.llm.installed

  const finish = () => {
    if (openAtLogin !== null && openAtLogin !== wantLogin) setOpenAtLogin(wantLogin)
    onDone()
  }

  return (
    <>
      <StepTitle title="You’re all set" description="Here’s what happens on your next call." />
      <ol className="space-y-4">
        {[
          [
            'Join a call',
            'In Zoom, Meet, Teams, Slack, Discord or FaceTime. A small panel in the corner asks “Transcribe this call?”',
          ],
          [
            'Oatmeal listens quietly',
            `Nothing pops up over your call. The ${isMac ? 'menu-bar' : 'tray'} icon turns red while it records.`,
          ],
          [
            'Your notes arrive',
            `When the call ends, notes are written on this ${machine}, and the panel offers to open them.`,
          ],
        ].map(([title, body], i) => (
          <li key={title} className="flex gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand font-mono text-xs font-medium text-brand-foreground">
              {i + 1}
            </span>
            <div>
              <div className="text-sm font-medium">{title}</div>
              <div className="text-sm text-muted-foreground">{body}</div>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-8 space-y-4 rounded-xl border bg-card p-4 shadow-card">
        <p className="text-sm text-muted-foreground">
          Oatmeal lives in the {isMac ? 'menu bar' : 'system tray'}. Closing this window doesn’t quit it, and you can
          start recording any time from there.
        </p>
        {openAtLogin !== null && (
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="open-at-login" className="font-normal">
              Open Oatmeal when you log in, so it’s ready for your calls
            </Label>
            <Switch id="open-at-login" checked={wantLogin} onCheckedChange={setWantLogin} />
          </div>
        )}
      </div>

      {!notesReady && (
        <p className="mt-4 text-sm text-muted-foreground">
          {llmDownload && running(llmDownload)
            ? `The notes model is still downloading (${percent(llmDownload) ?? 0}%). Calls you record before it’s done get their notes when it finishes.`
            : 'No notes model yet, so calls will be transcribed without notes. Set one up any time in Settings.'}
        </p>
      )}

      <Button size="lg" className="mt-8" onClick={finish}>
        Start using Oatmeal
      </Button>
    </>
  )
}
