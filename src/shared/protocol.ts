/** Messages between the main process and the utility processes (ASR and LLM workers). */
import type { Turn } from './transcript'
import type { Channel, LlmModelId, MeetingSummary } from './types'

/** Generic request/response envelope. */
export interface WorkerRequest<T extends string = string, P = unknown> {
  kind: 'request'
  id: number
  type: T
  payload: P
}

export type WorkerResponse = { kind: 'response'; id: number; ok: true; result: unknown } | { kind: 'response'; id: number; ok: false; error: string }

export interface WorkerEvent<T extends string = string, P = unknown> {
  kind: 'event'
  type: T
  payload: P
}

// ---------------------------------------------------------------- ASR worker

export type AudioSourceSpec =
  | { kind: 'helper'; helperPath: string; excludePids: number[] }
  /** Development/testing: plays WAV files as if they were the two capture channels. */
  | { kind: 'files'; mic?: string; system?: string; speed: number }

export interface AsrRequests {
  init: { payload: { libDir: string; modelsDir: string }; result: { version: number } }
  'model-status': { payload: { arch: number }; result: { installed: boolean; diarizationInstalled: boolean } }
  download: { payload: { arch: number; diarization: boolean }; result: void }
  start: { payload: { arch: number; separateSpeakers: boolean; source: AudioSourceSpec }; result: void }
  stop: { payload: Record<string, never>; result: void }
}

export interface AsrLine {
  /** Unique within a meeting: channel prefix + Moonshine line id. */
  lineId: string
  channel: Channel
  startMs: number
  endMs: number
  text: string
  /** Whether this channel is being diarized (system channel with speaker separation on). */
  diarized: boolean
  /** Remote speaker index from diarization, when known. */
  speakerIndex: number | null
}

export interface AsrEvents {
  line: AsrLine
  speaker: { lineId: string; speakerIndex: number }
  activity: { channel: Channel; active: boolean }
  /** Status lines from the capture helper (started, device-changed, warnings, errors). */
  capture: Record<string, unknown>
  'download-progress': { file: string; loaded: number; total: number | null }
  /** The audio source finished on its own (helper exited, or test files ran out). */
  'source-ended': { reason: string }
  error: { message: string }
}

// ---------------------------------------------------------------- LLM worker

export type LlmConfig =
  | { provider: 'local'; modelId: LlmModelId; modelPath: string }
  | { provider: 'endpoint'; baseUrl: string; model: string; apiKey: string }

export interface LlmRequests {
  'model-status': { payload: { modelId: LlmModelId; modelsDir: string }; result: { installed: boolean; path: string } }
  download: { payload: { modelId: LlmModelId; modelsDir: string }; result: { path: string } }
  'cancel-download': { payload: Record<string, never>; result: void }
  /** Load the model ahead of time (e.g. while a call is ending) so notes start immediately. */
  preload: { payload: { config: LlmConfig }; result: void }
  summarize: {
    payload: { jobId: string; config: LlmConfig; turns: Turn[]; cache: Record<string, unknown> }
    result: { summary: MeetingSummary; cache: Record<string, unknown> }
  }
  cancel: { payload: { jobId: string }; result: void }
  unload: { payload: Record<string, never>; result: void }
}

export interface LlmEvents {
  'download-progress': { file: string; loaded: number; total: number | null }
  progress: { jobId: string; stage: 'loading' | 'map' | 'reduce'; done: number; total: number }
}
