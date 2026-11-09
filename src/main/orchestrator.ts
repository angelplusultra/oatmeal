/**
 * The meeting state machine: idle → (prompted) → recording → finalizing → idle, plus the notes queue,
 * model management and echo filtering. Everything the UI shows flows out through `broadcast`.
 *
 * Nothing here brings a window forward on its own: recording runs in the background, and when notes are
 * ready a small floating panel offers to open them.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { OatmealEvents } from '@shared/api'
import { callEndDecision } from '@shared/call-end'
import { isEcho } from '@shared/echo'
import { asrModel, LLM_MODELS, llmModel } from '@shared/models'
import type {
  AsrEvents,
  AsrLine,
  AsrRequests,
  AudioSourceSpec,
  LlmConfig,
  LlmEvents,
  LlmRequests,
} from '@shared/protocol'
import { buildTurns } from '@shared/transcript'
import type {
  DownloadProgress,
  FoundModel,
  Meeting,
  MeetingSummary,
  ModelKind,
  ModelStatus,
  PanelAction,
  PanelState,
  RecordingState,
  Segment,
  Settings,
} from '@shared/types'
import type { Store } from './db'
import type { DetectedMeetingApp, MeetingDetector } from './detector'
import { findModelFiles } from './find-models'
import type { Paths } from './paths'
import type { WorkerClient } from './worker-client'

export interface OrchestratorDeps {
  store: Store
  paths: Paths
  asr: WorkerClient<AsrRequests, AsrEvents>
  llm: WorkerClient<LlmRequests, LlmEvents>
  detector: MeetingDetector
  getSettings(): Settings
  updateSettings(patch: Partial<Settings>): Settings
  broadcast<K extends keyof OatmealEvents>(event: K, payload: OatmealEvents[K]): void
  ui: {
    showPanel(): void
    hidePanel(): void
    /** Brings Oatmeal to the front on a meeting. Only on an explicit request (e.g. "View notes"). */
    showMeeting(meetingId: string): void
    showSettings(): void
    notify(title: string, body: string): void
    /** The user is looking at Oatmeal's main window right now. */
    isMainFocused(): boolean
  }
  /** PIDs of Oatmeal's own processes, excluded from the system-audio tap. */
  ownPids(): number[]
  /** Development: replace live capture with WAV files (OATMEAL_FAKE_AUDIO). */
  fakeAudio?: Extract<AudioSourceSpec, { kind: 'files' }>
  /** Development: use an existing GGUF instead of the downloaded one (OATMEAL_LLM_MODEL_PATH). */
  llmModelOverride?: string
}

const PROMPT_TIMEOUT_MS = 45_000
const END_CHECK_INTERVAL_MS = 500
const ECHO_WINDOW_MS = 60_000

function defaultTitle(sourceApp: string | null, startedAt: number): string {
  const time = new Date(startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return sourceApp ? `${sourceApp} call · ${time}` : `Meeting · ${time}`
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class Orchestrator {
  private state: RecordingState = { kind: 'idle' }
  private recent: Segment[] = []
  private panel: PanelState | null = null
  private promptTimer: NodeJS.Timeout | null = null
  /** Runs while the meeting app has released the mic, to decide whether the call ended (shared/call-end.ts). */
  private endWatch: NodeJS.Timeout | null = null
  private micReleasedAt = 0
  private remoteSpeaking = false
  private lastRemoteSpeechAt = 0
  private readonly snoozed = new Set<string>()
  private readonly summaryQueue: string[] = []
  private summarizing: string | null = null
  private downloads: Partial<Record<ModelKind, DownloadProgress>> = {}
  /** Meetings that ended while the notes model was still downloading. Their notes are written when it finishes. */
  private readonly waitingForModel = new Set<string>()
  private lastProgressBroadcast = 0
  private captureErrorShown = false
  private startPending = false

  constructor(private readonly deps: OrchestratorDeps) {
    const { asr, llm, detector } = deps
    asr.on('line', (line) => this.onLine(line))
    asr.on('speaker', ({ lineId, speakerIndex }) => this.onSpeaker(lineId, speakerIndex))
    asr.on('activity', (activity) => {
      if (activity.channel === 'system') {
        this.remoteSpeaking = activity.active
        this.lastRemoteSpeechAt = Date.now()
      }
      deps.broadcast('activity', activity)
    })
    asr.on('capture', (event) => this.onCaptureEvent(event))
    asr.on('source-ended', ({ reason }) => {
      console.log(`[asr] audio source ended: ${reason}`)
      if (this.state.kind === 'recording') void this.stop(reason === 'test audio finished' ? 'auto' : 'error')
    })
    asr.on('error', ({ message }) => console.error('[asr]', message))
    asr.on('download-progress', (p) => this.onDownloadProgress('asr', p))
    asr.onExit((code) => {
      console.error(`[asr] worker exited unexpectedly (code ${code})`)
      if (this.state.kind === 'recording') {
        deps.broadcast('toast', {
          kind: 'error',
          message: 'Transcription stopped unexpectedly. The transcript so far was saved.',
        })
        void this.stop('error')
      }
    })
    llm.on('download-progress', (p) => this.onDownloadProgress('llm', p))
    llm.on('progress', ({ jobId, ...p }) => deps.broadcast('summary-progress', { meetingId: jobId, ...p }))

    // No call prompts until first-run setup is done: before that, "Transcribe" couldn't work.
    detector.onStarted((app) => {
      if (deps.getSettings().onboarded) this.handleAppStarted(app)
    })
    detector.onStopped((app) => this.onAppStopped(app))
  }

  getState(): RecordingState {
    return this.state
  }

  private setState(state: RecordingState) {
    this.state = state
    this.deps.broadcast('recording-state', state)
  }

  /** Marks meetings interrupted by a crash or force-quit as transcribed so they can be resumed. */
  recoverUnfinished() {
    const { store } = this.deps
    for (const m of store.unfinishedMeetings()) {
      const endedAt = m.endedAt ?? m.startedAt + (store.lastSegmentEnd(m.id) ?? 0)
      store.updateMeeting(m.id, { status: 'transcribed', endedAt })
    }
  }

  // ------------------------------------------------------------------ recording

  async start(sourceApp: string | null): Promise<void> {
    if (this.state.kind !== 'idle' || this.startPending) return
    const { store, asr, broadcast } = this.deps
    const settings = this.deps.getSettings()
    const asrInfo = asrModel(settings.asrModel)

    // Guard against double-starts while the (async) model check runs.
    this.startPending = true
    let installed = false
    try {
      installed = (await this.modelStatus()).asr.installed
    } finally {
      this.startPending = false
    }
    if (!installed || this.state.kind !== 'idle') {
      if (!installed) {
        broadcast('toast', { kind: 'error', message: 'Download the speech model in Settings before recording.' })
        this.deps.ui.showSettings()
      }
      return
    }

    if (this.panel?.kind === 'call') this.hidePanel()
    const id = randomUUID()
    const startedAt = Date.now()
    store.createMeeting({ id, title: defaultTitle(sourceApp, startedAt), sourceApp, startedAt, asrModel: asrInfo.name })
    this.recent = []
    this.captureErrorShown = false
    this.setState({ kind: 'starting', meetingId: id })
    broadcast('meetings-changed', null)

    const source: AudioSourceSpec = this.deps.fakeAudio ?? {
      kind: 'helper',
      helperPath: this.deps.paths.helper,
      excludePids: this.deps.ownPids(),
    }
    try {
      await asr.request('start', { arch: asrInfo.arch, separateSpeakers: settings.separateSpeakers, source })
    } catch (error) {
      store.deleteMeeting(id)
      this.setState({ kind: 'idle' })
      broadcast('meetings-changed', null)
      broadcast('toast', { kind: 'error', message: `Could not start recording: ${errorMessage(error)}` })
      this.deps.ui.notify("Couldn't start transcribing", errorMessage(error))
      return
    }
    // Recording runs in the background: the menu-bar icon turns red, but no window pops up over the call.
    this.remoteSpeaking = false
    this.lastRemoteSpeechAt = Date.now()
    this.setState({ kind: 'recording', meetingId: id, startedAt, sourceApp })
  }

  async stop(reason: 'user' | 'auto' | 'error' | 'quit' = 'user'): Promise<void> {
    if (this.state.kind !== 'recording') return
    const { meetingId } = this.state
    const { store, asr, broadcast } = this.deps
    console.log(`[recording] stopping (${reason})`)
    this.clearEndWatch()
    if (reason !== 'quit') this.preloadNotesModel()
    this.setState({ kind: 'stopping', meetingId })
    try {
      await asr.request('stop', {})
    } catch (error) {
      console.error('[asr] stop failed', error)
    }
    store.updateMeeting(meetingId, { endedAt: Date.now(), status: 'transcribed' })
    this.recent = []
    this.setState({ kind: 'idle' })
    broadcast('meetings-changed', null)
    broadcast('meeting-updated', { meetingId })
    if (reason === 'quit') return
    // No window here: the notes panel appears when the notes are ready.
    this.enqueueNotes(meetingId, { announce: true })
  }

  private currentMeetingId(): string | null {
    return this.state.kind === 'recording' || this.state.kind === 'stopping' ? this.state.meetingId : null
  }

  private onLine(line: AsrLine) {
    const meetingId = this.currentMeetingId()
    if (!meetingId) return
    // Until diarization assigns a remote line to someone (it may later, via a 'speaker' event), call it "Them".
    const speaker =
      line.channel === 'mic' ? 'me' : line.diarized && line.speakerIndex !== null ? `sys:${line.speakerIndex}` : 'them'
    const draft: Omit<Segment, 'id'> = {
      meetingId,
      lineId: line.lineId,
      channel: line.channel,
      speaker,
      startMs: line.startMs,
      endMs: line.endMs,
      text: line.text,
      echo: false,
    }
    this.recent = this.recent.filter((s) => s.endMs >= draft.startMs - ECHO_WINDOW_MS)
    if (draft.channel === 'mic') {
      draft.echo = this.recent.some((s) => s.channel === 'system' && isEcho(draft, s))
    }
    if (draft.channel === 'system') this.lastRemoteSpeechAt = Date.now()
    const segment = this.deps.store.insertSegment(draft)
    if (!segment) return
    this.deps.broadcast('segment', { meetingId, segment })
    if (segment.channel === 'system') {
      // The system copy of an echo can arrive after the mic copy; retroactively hide the mic one.
      for (const mic of this.recent) {
        if (mic.channel !== 'mic' || mic.echo || !isEcho(mic, segment)) continue
        mic.echo = true
        const updated = this.deps.store.updateSegment(meetingId, mic.lineId, { echo: true })
        if (updated) this.deps.broadcast('segment', { meetingId, segment: updated })
      }
    }
    this.recent.push(segment)
  }

  private onSpeaker(lineId: string, speakerIndex: number) {
    const meetingId = this.currentMeetingId()
    if (!meetingId) return
    const updated = this.deps.store.updateSegment(meetingId, lineId, { speaker: `sys:${speakerIndex}` })
    if (updated) this.deps.broadcast('segment', { meetingId, segment: updated })
  }

  private onCaptureEvent(event: Record<string, unknown>) {
    if (event.type === 'error' && !this.captureErrorShown) {
      this.captureErrorShown = true
      const channel = event.channel === 'system' ? 'system audio' : 'microphone'
      this.deps.broadcast('toast', {
        kind: 'error',
        message: `Couldn't capture the ${channel}. Check Oatmeal's permissions in Settings. (${String(event.message ?? '')})`,
      })
    }
    if (event.type === 'warning') console.warn('[capture]', event)
  }

  // ------------------------------------------------------------------ detection & panel

  /** A meeting app started using the mic: offer to transcribe, or keep recording if it came back. Public for dev hooks. */
  handleAppStarted(app: DetectedMeetingApp) {
    if (this.state.kind === 'recording') {
      if (app.name === this.state.sourceApp) this.clearEndWatch()
      return
    }
    if (this.state.kind !== 'idle' || this.panel?.kind === 'call') return
    const settings = this.deps.getSettings()
    if (!settings.detectionEnabled || settings.ignoredApps.includes(app.name) || this.snoozed.has(app.name)) return
    this.setPanel({ kind: 'call', app })
    this.promptTimer = setTimeout(() => {
      if (this.panel?.kind === 'call') {
        this.snoozed.add(this.panel.app.name)
        this.hidePanel()
      }
    }, PROMPT_TIMEOUT_MS)
  }

  private onAppStopped(app: DetectedMeetingApp) {
    this.snoozed.delete(app.name)
    if (this.panel?.kind === 'call' && this.panel.app.name === app.name) this.hidePanel()
    if (this.state.kind === 'recording' && this.state.sourceApp === app.name) this.watchForCallEnd(app.name)
  }

  /** The meeting app released the mic. Check twice a second whether the call is really over. */
  private watchForCallEnd(appName: string) {
    this.clearEndWatch()
    this.micReleasedAt = Date.now()
    this.preloadNotesModel()
    const { detector } = this.deps
    this.endWatch = setInterval(() => {
      if (this.state.kind !== 'recording' || detector.hasMic(appName)) return this.clearEndWatch()
      const decision = callEndDecision({
        now: Date.now(),
        micReleasedAt: this.micReleasedAt,
        appPlaying: detector.isPlaying(appName),
        playingStoppedAt: detector.playingStoppedAt(appName),
        lastRemoteSpeechAt: this.lastRemoteSpeechAt,
        remoteSpeaking: this.remoteSpeaking,
        silenceTimeoutMs: this.deps.getSettings().autoStopSeconds * 1000,
      })
      if (decision === 'stop') {
        this.clearEndWatch()
        void this.stop('auto')
      }
    }, END_CHECK_INTERVAL_MS)
  }

  private clearEndWatch() {
    if (this.endWatch) clearInterval(this.endWatch)
    this.endWatch = null
  }

  getPanel(): PanelState | null {
    return this.panel
  }

  private setPanel(panel: PanelState) {
    if (this.promptTimer) clearTimeout(this.promptTimer)
    this.promptTimer = null
    this.panel = panel
    this.deps.broadcast('panel', panel)
    this.deps.ui.showPanel()
  }

  private hidePanel() {
    if (this.promptTimer) clearTimeout(this.promptTimer)
    this.promptTimer = null
    if (!this.panel) return
    this.panel = null
    this.deps.broadcast('panel', null)
    this.deps.ui.hidePanel()
  }

  /** The user opened Oatmeal themselves, so a "notes ready" panel has done its job. */
  onMainWindowFocused() {
    if (this.panel?.kind === 'notes') this.hidePanel()
  }

  /** When the user last answered the panel (see `recentlyPrompted`). */
  private panelAnsweredAt = 0

  /** True right after the user answered the panel, when an app activation is a side effect, not a request to open Oatmeal. */
  recentlyPrompted(): boolean {
    return Date.now() - this.panelAnsweredAt < 3000
  }

  async respondToPanel(action: PanelAction) {
    this.panelAnsweredAt = Date.now()
    const current = this.panel
    this.hidePanel()
    if (!current) return
    if (current.kind === 'notes') {
      if (action === 'view') this.deps.ui.showMeeting(current.meetingId)
      return
    }
    if (action === 'start') {
      await this.start(current.app.name)
    } else if (action === 'dismiss') {
      this.snoozed.add(current.app.name)
    } else if (action === 'never') {
      const settings = this.deps.getSettings()
      this.deps.updateSettings({ ignoredApps: [...new Set([...settings.ignoredApps, current.app.name])] })
    }
  }

  /** "Your notes are ready" panel, unless the user is already looking at Oatmeal or deciding on a new call. */
  private announceNotes(meeting: Meeting, outcome: 'ready' | 'failed' | 'empty', preview: string | null) {
    if (this.deps.ui.isMainFocused() || this.panel?.kind === 'call') return
    this.setPanel({ kind: 'notes', meetingId: meeting.id, title: meeting.title, outcome, preview })
  }

  // ------------------------------------------------------------------ notes

  private readonly announceWhenDone = new Set<string>()

  /** Queues notes for a meeting. `announce` shows the "notes ready" panel when they're done (after a call). */
  enqueueNotes(meetingId: string, { announce = false } = {}) {
    if (announce) this.announceWhenDone.add(meetingId)
    if (this.summarizing === meetingId || this.summaryQueue.includes(meetingId)) return
    this.summaryQueue.push(meetingId)
    void this.pumpNotes()
  }

  private async pumpNotes() {
    if (this.summarizing) return
    const next = this.summaryQueue.shift()
    if (!next) return
    this.summarizing = next
    try {
      const outcome = await this.writeNotes(next)
      const meeting = this.deps.store.getMeeting(next)
      if (outcome && meeting && this.announceWhenDone.has(next)) {
        const preview =
          outcome === 'ready'
            ? (meeting.summary?.tldr ?? null)
            : outcome === 'empty'
              ? 'Nothing was said, so there are no notes.'
              : meeting.error
        this.announceNotes(meeting, outcome, preview)
      }
    } finally {
      this.announceWhenDone.delete(next)
      this.summarizing = null
      void this.pumpNotes()
    }
  }

  private llmModelPath(settings: Settings): string {
    return this.deps.llmModelOverride || settings.localModelPath || this.ownLlmPath(settings)
  }

  private ownLlmPath(settings: Settings): string {
    return path.join(this.deps.paths.models, 'llm', llmModel(settings.localModel).fileName)
  }

  /** ponytail: scanned once per model per run; a model downloaded elsewhere meanwhile shows up after a restart. */
  private foundModels = new Map<string, FoundModel[]>()
  private findExisting(fileName: string): FoundModel[] {
    if (!this.foundModels.has(fileName)) this.foundModels.set(fileName, findModelFiles(fileName))
    return this.foundModels.get(fileName)!
  }

  private llmConfig(settings: Settings): LlmConfig | { error: string } {
    if (settings.llmProvider === 'endpoint') {
      if (!settings.endpointUrl || !settings.endpointModel)
        return { error: 'Set the endpoint URL and model in Settings.' }
      return {
        provider: 'endpoint',
        baseUrl: settings.endpointUrl,
        model: settings.endpointModel,
        apiKey: settings.endpointApiKey,
      }
    }
    const modelPath = this.llmModelPath(settings)
    if (!fs.existsSync(modelPath)) {
      return {
        error: settings.localModelPath
          ? `The notes model file is missing (${modelPath}). Choose another in Settings.`
          : 'Download the notes model in Settings to generate notes.',
      }
    }
    // A Gemma we know keeps its display name; any other GGUF is named after its file.
    const base = path.basename(modelPath)
    const known = LLM_MODELS.find((m) => base === m.fileName || base.endsWith(`_${m.fileName}`))
    return { provider: 'local', modelName: known?.name ?? base.replace(/\.gguf$/i, ''), modelPath }
  }

  private async writeNotes(meetingId: string): Promise<'ready' | 'failed' | 'empty' | null> {
    const { store, llm, broadcast } = this.deps
    const meeting = store.getMeeting(meetingId)
    if (!meeting) return null
    const turns = buildTurns(store.getSegments(meetingId), meeting.speakerNames)
    const done = () => {
      broadcast('meeting-updated', { meetingId })
      broadcast('meetings-changed', null)
    }

    if (!turns.length) {
      const empty: MeetingSummary = {
        title: meeting.title,
        tldr: 'No speech was transcribed for this meeting.',
        keyPoints: [],
        decisions: [],
        actionItems: [],
        openQuestions: [],
        generatedAt: Date.now(),
        model: 'none',
      }
      store.updateMeeting(meetingId, { status: 'done', summary: empty, error: null })
      done()
      return 'empty'
    }

    const settings = this.deps.getSettings()
    const config = this.llmConfig(settings)
    if ('error' in config && settings.llmProvider === 'local' && !settings.localModelPath && this.downloading('llm')) {
      // Set up during onboarding, still arriving: write these notes when the download finishes.
      this.waitingForModel.add(meetingId)
      store.updateMeeting(meetingId, { status: 'transcribed', error: null })
      broadcast('toast', {
        kind: 'info',
        message: 'Your notes will be written when the notes model finishes downloading.',
      })
      done()
      return null
    }
    if ('error' in config) {
      store.updateMeeting(meetingId, { status: 'transcribed', error: config.error })
      broadcast('toast', { kind: 'error', message: config.error })
      done()
      return 'failed'
    }

    store.updateMeeting(meetingId, { status: 'summarizing', error: null })
    done()
    let outcome: 'ready' | 'failed' = 'ready'
    try {
      const { summary, cache } = await llm.request('summarize', {
        jobId: meetingId,
        config,
        turns,
        cache: store.getMapCache(meetingId),
      })
      store.saveMapCache(meetingId, cache)
      const autoTitle = store.isTitleAuto(meetingId)
      store.updateMeeting(meetingId, {
        status: 'done',
        summary,
        error: null,
        ...(autoTitle && summary.title ? { title: summary.title } : {}),
      })
    } catch (error) {
      outcome = 'failed'
      store.updateMeeting(meetingId, { status: 'failed', error: `Couldn't write notes: ${errorMessage(error)}` })
      broadcast('toast', { kind: 'error', message: `Couldn't write notes: ${errorMessage(error)}` })
    }
    done()
    return outcome
  }

  /** Starts loading the notes model while the call wraps up, so writing notes can begin right away. */
  private preloadNotesModel() {
    const config = this.llmConfig(this.deps.getSettings())
    if ('error' in config) return
    this.deps.llm.request('preload', { config }).catch((error) => console.warn('[llm] preload failed', error))
  }

  // ------------------------------------------------------------------ models

  async modelStatus(): Promise<ModelStatus> {
    const settings = this.deps.getSettings()
    let asr = { installed: false, diarizationInstalled: false }
    try {
      asr = await this.deps.asr.request('model-status', { arch: asrModel(settings.asrModel).arch })
    } catch (error) {
      console.error('[asr] model-status failed', error)
    }
    const llmPath = this.llmModelPath(settings)
    const installed = fs.existsSync(llmPath)
    const found = installed || settings.localModelPath ? [] : this.findExisting(llmModel(settings.localModel).fileName)
    return {
      asr: { id: settings.asrModel, ...asr },
      llm: { id: settings.localModel, installed, path: llmPath, found },
      downloads: this.downloads,
    }
  }

  private async broadcastModelStatus() {
    this.deps.broadcast('model-status', await this.modelStatus())
  }

  private downloading(kind: ModelKind): boolean {
    const download = this.downloads[kind]
    return !!download && !download.done && !download.error
  }

  private onDownloadProgress(kind: ModelKind, p: { file: string; loaded: number; total: number | null }) {
    this.downloads = { ...this.downloads, [kind]: { kind, ...p } }
    const now = Date.now()
    if (now - this.lastProgressBroadcast < 250) return
    this.lastProgressBroadcast = now
    void this.broadcastModelStatus()
  }

  /** The speech and notes models download in their own workers, so both can run at once. */
  async downloadModel(kind: ModelKind) {
    if (this.downloading(kind))
      throw new Error(`The ${kind === 'asr' ? 'speech' : 'notes'} model is already downloading`)
    const settings = this.deps.getSettings()
    const finish = (patch: Partial<DownloadProgress>) => {
      this.downloads = { ...this.downloads, [kind]: { ...this.downloads[kind]!, ...patch } }
    }
    this.downloads = { ...this.downloads, [kind]: { kind, file: '', loaded: 0, total: null } }
    void this.broadcastModelStatus()
    try {
      if (kind === 'asr') {
        await this.deps.asr.request('download', { arch: asrModel(settings.asrModel).arch, diarization: true })
      } else {
        await this.deps.llm.request('download', { modelId: settings.localModel, modelsDir: this.deps.paths.models })
      }
      finish({ done: true })
    } catch (error) {
      finish({ error: errorMessage(error) })
    }
    await this.broadcastModelStatus()
    if (kind === 'llm') {
      // Calls that ended mid-download get their notes now (or the usual "download the model" error if it failed).
      const waiting = [...this.waitingForModel]
      this.waitingForModel.clear()
      for (const meetingId of waiting) this.enqueueNotes(meetingId, { announce: true })
    }
  }

  async cancelDownload() {
    if (this.downloading('llm')) await this.deps.llm.request('cancel-download', {})
  }

  /** Stops recording (keeping the transcript) and shuts the workers down. */
  async shutdown() {
    this.hidePanel()
    await this.stop('quit')
    this.deps.detector.stop()
    this.deps.asr.kill()
    this.deps.llm.kill()
  }
}
