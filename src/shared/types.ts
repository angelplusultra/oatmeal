/** Which capture stream a line came from. `mic` is the local user; `system` is everyone else. */
export type Channel = 'mic' | 'system'

/**
 * Who said a line.
 * - `me`: the local microphone (the person running Oatmeal)
 * - `them`: system audio when remote speakers are not separated
 * - `sys:N`: the Nth distinct remote speaker found by diarization (0-based)
 */
export type SpeakerKey = string

export interface Segment {
  id: number
  meetingId: string
  /** Stable id of the ASR line this segment came from, prefixed with the channel. */
  lineId: string
  channel: Channel
  speaker: SpeakerKey
  startMs: number
  endMs: number
  text: string
  /** True when a mic line was judged to be the remote audio leaking from speakers into the mic. */
  echo: boolean
}

export type MeetingStatus = 'recording' | 'transcribed' | 'summarizing' | 'done' | 'failed'

export interface Decision {
  text: string
  /** Milliseconds from the start of the meeting where it was said, when known. */
  ts: number | null
}

export interface ActionItem {
  task: string
  owner: string | null
  due: string | null
  ts: number | null
  done: boolean
}

export interface KeyPointGroup {
  topic: string
  points: string[]
}

export interface MeetingSummary {
  title: string
  tldr: string
  keyPoints: KeyPointGroup[]
  decisions: Decision[]
  actionItems: ActionItem[]
  openQuestions: string[]
  generatedAt: number
  model: string
}

export interface Meeting {
  id: string
  title: string
  /** Display name of the app that triggered the meeting, or null for manual recordings. */
  sourceApp: string | null
  startedAt: number
  endedAt: number | null
  status: MeetingStatus
  summary: MeetingSummary | null
  error: string | null
  asrModel: string | null
  speakerNames: Record<SpeakerKey, string>
}

export type MeetingListItem = Pick<Meeting, 'id' | 'title' | 'sourceApp' | 'startedAt' | 'endedAt' | 'status'>

export type AsrModelId = 'medium' | 'small'
export type LlmModelId = 'gemma-4-e2b' | 'gemma-4-e4b' | 'gemma-4-26b-a4b'

export interface Settings {
  /** Watch for meeting apps using the microphone and offer to transcribe. */
  detectionEnabled: boolean
  /**
   * When the meeting app releases the mic but keeps playing audio (e.g. you're muted), stop once nobody has
   * spoken for this many seconds. If it goes quiet too, recording stops after ~2 s.
   */
  autoStopSeconds: number
  /** Bundle ids (or app names) the user chose to never be prompted for. */
  ignoredApps: string[]
  asrModel: AsrModelId
  /** Split the system-audio channel into individual remote speakers. */
  separateSpeakers: boolean
  llmProvider: 'local' | 'endpoint'
  localModel: LlmModelId
  /** A GGUF already on disk to use instead of Oatmeal's own download. Empty = Oatmeal's copy of `localModel`. */
  localModelPath: string
  /** OpenAI-compatible endpoint (Ollama, LM Studio, llama-server…), used when llmProvider = 'endpoint'. */
  endpointUrl: string
  endpointModel: string
  endpointApiKey: string
}

export type RecordingState =
  | { kind: 'idle' }
  | { kind: 'starting'; meetingId: string }
  | { kind: 'recording'; meetingId: string; startedAt: number; sourceApp: string | null }
  | { kind: 'stopping'; meetingId: string }

export interface LiveLine {
  meetingId: string
  segment: Segment
}

export type ModelKind = 'asr' | 'llm'

export interface ModelStatus {
  asr: { id: AsrModelId; installed: boolean; diarizationInstalled: boolean }
  llm: { id: LlmModelId; installed: boolean; path: string | null; /** Copies of `id` other apps already downloaded. */ found: FoundModel[] }
  download: DownloadProgress | null
}

export interface FoundModel {
  path: string
  /** The app that downloaded it, e.g. "LM Studio". */
  source: string
}

export interface DownloadProgress {
  kind: ModelKind
  file: string
  loaded: number
  total: number | null
  error?: string
  done?: boolean
}

export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'

export interface PermissionStatus {
  microphone: PermissionState
  systemAudio: PermissionState
  helperAvailable: boolean
}

export interface DetectedApp {
  pid: number
  bundleId: string
  name: string
}

/**
 * The small floating panel. It never steals focus:
 * - `call`: a meeting app started using the mic. Offer to transcribe.
 * - `notes`: a call's notes are ready (or failed). Offer to open them.
 */
export type PanelState =
  | { kind: 'call'; app: DetectedApp & { name: string } }
  | { kind: 'notes'; meetingId: string; title: string; outcome: 'ready' | 'failed' | 'empty'; preview: string | null }

export type PanelAction = 'start' | 'dismiss' | 'never' | 'view'

export interface SummaryProgress {
  meetingId: string
  stage: 'loading' | 'map' | 'reduce'
  done: number
  total: number
}
