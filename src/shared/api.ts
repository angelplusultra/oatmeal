/** The API the preload script exposes to the renderer as `window.oatmeal`. */
import type {
  Channel,
  Meeting,
  MeetingListItem,
  ModelKind,
  ModelStatus,
  PanelAction,
  PanelState,
  PermissionStatus,
  RecordingState,
  Segment,
  Settings,
  SummaryProgress,
} from './types'

export type ExportFormat = 'notes-md' | 'transcript-txt' | 'transcript-md' | 'transcript-json'

export interface OatmealEvents {
  'meetings-changed': null
  'meeting-updated': { meetingId: string }
  /** A new transcript line, or an existing one whose speaker/echo flag changed. */
  segment: { meetingId: string; segment: Segment }
  activity: { channel: Channel; active: boolean }
  'recording-state': RecordingState
  'summary-progress': SummaryProgress
  'model-status': ModelStatus
  panel: PanelState | null
  navigate: { meetingId: string } | { view: 'settings' }
  toast: { kind: 'info' | 'success' | 'error'; message: string }
}

export interface OatmealInvoke {
  listMeetings(query?: string): Promise<MeetingListItem[]>
  getMeeting(id: string): Promise<Meeting | null>
  getSegments(id: string): Promise<Segment[]>
  renameMeeting(id: string, title: string): Promise<void>
  renameSpeaker(id: string, key: string, name: string): Promise<void>
  deleteMeeting(id: string): Promise<void>
  generateNotes(id: string): Promise<void>
  setActionItemDone(id: string, index: number, done: boolean): Promise<void>
  exportMeeting(id: string, format: ExportFormat): Promise<boolean>
  copyNotes(id: string): Promise<void>
  startRecording(): Promise<void>
  stopRecording(): Promise<void>
  getRecordingState(): Promise<RecordingState>
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  getModelStatus(): Promise<ModelStatus>
  downloadModel(kind: ModelKind): Promise<void>
  cancelDownload(): Promise<void>
  getPermissions(): Promise<PermissionStatus>
  requestPermission(kind: 'microphone' | 'systemAudio'): Promise<PermissionStatus>
  openPermissionSettings(kind: 'microphone' | 'systemAudio'): Promise<void>
  openDataFolder(): Promise<void>
  getPanel(): Promise<PanelState | null>
  respondToPanel(action: PanelAction): Promise<void>
  /** Where the main window should open (set when it was created by a notification or a new recording). */
  takePendingNavigation(): Promise<OatmealEvents['navigate'] | null>
}

export const INVOKE_METHODS = [
  'listMeetings',
  'getMeeting',
  'getSegments',
  'renameMeeting',
  'renameSpeaker',
  'deleteMeeting',
  'generateNotes',
  'setActionItemDone',
  'exportMeeting',
  'copyNotes',
  'startRecording',
  'stopRecording',
  'getRecordingState',
  'getSettings',
  'updateSettings',
  'getModelStatus',
  'downloadModel',
  'cancelDownload',
  'getPermissions',
  'requestPermission',
  'openPermissionSettings',
  'openDataFolder',
  'getPanel',
  'respondToPanel',
  'takePendingNavigation',
] as const satisfies readonly (keyof OatmealInvoke)[]

export interface OatmealApi extends OatmealInvoke {
  on<K extends keyof OatmealEvents>(event: K, listener: (payload: OatmealEvents[K]) => void): () => void
}

export const invokeChannel = (method: string) => `oatmeal:${method}`
export const eventChannel = (event: string) => `oatmeal-event:${event}`
