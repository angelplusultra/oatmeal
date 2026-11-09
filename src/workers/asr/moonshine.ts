/**
 * Native Moonshine Voice bindings via koffi (FFI). Mirrors core/moonshine-c-api.h from
 * https://github.com/moonshine-ai/moonshine. Native is ~2× cheaper on CPU than the WASM build.
 *
 * All calls are synchronous on purpose. Running them on libuv's worker threads (koffi `.async`)
 * crashes with SIGBUS once speaker diarization has a few dozen seconds of history: the diarizer needs
 * more stack than those threads have. This module only runs inside the ASR utility process, which does
 * nothing else, so blocking its thread for a transcription pass is fine.
 */

import path from 'node:path'
import koffi from 'koffi'

const LIB_NAMES: Record<string, string> = {
  darwin: 'libmoonshine.dylib',
  win32: 'moonshine.dll',
  linux: 'libmoonshine.so',
}

/** MOONSHINE_HEADER_VERSION the bindings below were written against. */
const HEADER_VERSION = 30000

export const FLAG_FORCE_UPDATE = 1

// Registered by name; referenced from the function signatures below.
koffi.struct('moonshine_option_t', { name: 'const char *', value: 'const char *' })
const SpeakerSpan = koffi.struct('speaker_span_t', {
  start_time: 'float',
  duration: 'float',
  speaker_id: 'uint64_t',
  speaker_index: 'uint32_t',
  start_char: 'uint64_t',
  end_char: 'uint64_t',
})
// Text is decoded lazily (only for lines we actually need), so it is declared as a raw pointer here.
const Line = koffi.struct('transcript_line_t', {
  text: 'void *',
  audio_data: 'void *',
  audio_data_count: 'size_t',
  start_time: 'float',
  duration: 'float',
  id: 'uint64_t',
  is_complete: 'int8_t',
  is_updated: 'int8_t',
  is_new: 'int8_t',
  has_text_changed: 'int8_t',
  have_speakers_changed: 'int8_t',
  speaker_spans: 'void *',
  speaker_span_count: 'uint64_t',
  last_transcription_latency_ms: 'uint32_t',
  words: 'void *',
  word_count: 'uint64_t',
})
const Transcript = koffi.struct('transcript_t', { lines: 'void *', line_count: 'uint64_t' })
const LINE_SIZE = koffi.sizeof(Line)

interface RawLine {
  text: unknown
  start_time: number
  duration: number
  id: bigint | number
  is_complete: number
  have_speakers_changed: number
  speaker_spans: unknown
  speaker_span_count: bigint | number
}

export interface MoonshineLine {
  index: number
  id: string
  startTime: number
  duration: number
  complete: boolean
  speakersChanged: boolean
  /** Decodes the line text (UTF-8). Only valid until the next call into the same transcriber. */
  text(): string
  /** Speaker index that covers most of the line, or null when diarization has no answer. */
  majoritySpeaker(): number | null
}

type NativeFn = (...args: unknown[]) => unknown

export class MoonshineLibrary {
  private readonly fns: Record<string, NativeFn>

  constructor(libDir: string) {
    const name = LIB_NAMES[process.platform]
    if (!name) throw new Error(`Moonshine is not available on ${process.platform}`)
    const lib = koffi.load(path.join(libDir, name))
    const f = (sig: string) => lib.func(sig) as unknown as NativeFn
    this.fns = {
      version: f('int32_t moonshine_get_version(void)'),
      errorToString: f('const char *moonshine_error_to_string(int32_t)'),
      freeBuffer: f('void moonshine_free_buffer(void *ptr)'),
      sttDeps: f(
        'int32_t moonshine_get_stt_dependencies(const char *language, const moonshine_option_t *options, uint64_t count, _Out_ void **json)',
      ),
      diarizationDeps: f('int32_t moonshine_get_diarization_dependencies(_Out_ void **json)'),
      load: f(
        'int32_t moonshine_load_transcriber_from_files(const char *path, uint32_t arch, const moonshine_option_t *options, uint64_t count, int32_t version)',
      ),
      freeTranscriber: f('void moonshine_free_transcriber(int32_t t)'),
      createStream: f('int32_t moonshine_create_stream(int32_t t, uint32_t flags)'),
      freeStream: f('int32_t moonshine_free_stream(int32_t t, int32_t s)'),
      startStream: f('int32_t moonshine_start_stream(int32_t t, int32_t s)'),
      stopStream: f('int32_t moonshine_stop_stream(int32_t t, int32_t s)'),
      addAudio: f(
        'int32_t moonshine_transcribe_add_audio_to_stream(int32_t t, int32_t s, const float *audio, uint64_t len, int32_t rate, uint32_t flags)',
      ),
      transcribe: f('int32_t moonshine_transcribe_stream(int32_t t, int32_t s, uint32_t flags, _Out_ void **out)'),
    }
  }

  version(): number {
    return this.fns.version() as number
  }

  errorMessage(code: number): string {
    return `${this.fns.errorToString(code) as string} (${code})`
  }

  private takeJson(ptr: unknown): unknown {
    try {
      return JSON.parse(koffi.decode(ptr, 'char', -1) as string)
    } finally {
      this.fns.freeBuffer(ptr)
    }
  }

  /** CDN manifest for a speech-to-text model: `{groups:[{base_url, files:[{name,url,size}]}]}`. */
  sttDependencies(language: string, arch: number): MoonshineManifest {
    const out: unknown[] = [null]
    const opts = [{ name: 'model_arch', value: String(arch) }]
    const rc = this.fns.sttDeps(language, opts, opts.length, out) as number
    if (rc !== 0) throw new Error(`moonshine_get_stt_dependencies: ${this.errorMessage(rc)}`)
    return this.takeJson(out[0]) as MoonshineManifest
  }

  diarizationDependencies(): MoonshineManifest {
    const out: unknown[] = [null]
    const rc = this.fns.diarizationDeps(out) as number
    if (rc !== 0) throw new Error(`moonshine_get_diarization_dependencies: ${this.errorMessage(rc)}`)
    return this.takeJson(out[0]) as MoonshineManifest
  }

  loadTranscriber(modelDir: string, arch: number, options: Record<string, string>): MoonshineTranscriber {
    const opts = Object.entries(options).map(([name, value]) => ({ name, value }))
    const handle = this.fns.load(modelDir, arch, opts, opts.length, HEADER_VERSION) as number
    if (handle < 0) throw new Error(`Failed to load speech model: ${this.errorMessage(handle)}`)
    return new MoonshineTranscriber(this, this.fns, handle)
  }
}

export interface MoonshineManifest {
  groups: { base_url: string; files: { name: string; url?: string; size?: number | null }[] }[]
}

export class MoonshineTranscriber {
  private freed = false

  constructor(
    private readonly lib: MoonshineLibrary,
    private readonly fns: Record<string, NativeFn>,
    readonly handle: number,
  ) {}

  createStream(): MoonshineStream {
    const stream = this.fns.createStream(this.handle, 0) as number
    if (stream < 0) throw new Error(`moonshine_create_stream: ${this.lib.errorMessage(stream)}`)
    const rc = this.fns.startStream(this.handle, stream) as number
    if (rc !== 0) throw new Error(`moonshine_start_stream: ${this.lib.errorMessage(rc)}`)
    return new MoonshineStream(this.lib, this.fns, this.handle, stream)
  }

  free(): void {
    if (this.freed) return
    this.freed = true
    this.fns.freeTranscriber(this.handle)
  }
}

/** One audio stream within a transcriber. */
export class MoonshineStream {
  constructor(
    private readonly lib: MoonshineLibrary,
    private readonly fns: Record<string, NativeFn>,
    private readonly transcriber: number,
    private readonly stream: number,
  ) {}

  addAudio(samples: Float32Array, sampleRate = 16000): void {
    if (!samples.length) return
    const rc = this.fns.addAudio(this.transcriber, this.stream, samples, samples.length, sampleRate, 0) as number
    if (rc !== 0) throw new Error(`moonshine_transcribe_add_audio_to_stream: ${this.lib.errorMessage(rc)}`)
  }

  /**
   * Runs a transcription pass and returns line views starting at `fromIndex`. Lines are never removed
   * and keep their index, so callers can skip lines they know are final.
   */
  transcribe(fromIndex: number, flags = 0): { lines: MoonshineLine[]; total: number } {
    const out: unknown[] = [null]
    const rc = this.fns.transcribe(this.transcriber, this.stream, flags, out) as number
    if (rc !== 0) throw new Error(`moonshine_transcribe_stream: ${this.lib.errorMessage(rc)}`)
    if (!out[0]) return { lines: [], total: 0 }
    const t = koffi.decode(out[0], Transcript) as { lines: unknown; line_count: bigint | number }
    const total = Number(t.line_count)
    const lines: MoonshineLine[] = []
    for (let i = Math.max(0, fromIndex); i < total; i++) {
      const raw = koffi.decode(t.lines, i * LINE_SIZE, Line) as RawLine
      lines.push(toLine(i, raw))
    }
    return { lines, total }
  }

  stop(): void {
    this.fns.stopStream(this.transcriber, this.stream)
  }

  free(): void {
    this.fns.freeStream(this.transcriber, this.stream)
  }
}

function toLine(index: number, raw: RawLine): MoonshineLine {
  return {
    index,
    id: String(raw.id),
    startTime: raw.start_time,
    duration: raw.duration,
    complete: raw.is_complete !== 0,
    speakersChanged: raw.have_speakers_changed !== 0,
    text: () => (raw.text ? (koffi.decode(raw.text, 'char', -1) as string) : ''),
    majoritySpeaker: () => {
      const count = Number(raw.speaker_span_count)
      if (!count || !raw.speaker_spans) return null
      const spans = koffi.decode(raw.speaker_spans, koffi.array(SpeakerSpan, count)) as {
        duration: number
        speaker_index: number
      }[]
      const totals = new Map<number, number>()
      for (const s of spans) totals.set(s.speaker_index, (totals.get(s.speaker_index) ?? 0) + s.duration)
      let best: number | null = null
      let bestDuration = -1
      for (const [speaker, duration] of totals) {
        if (duration > bestDuration) {
          best = speaker
          bestDuration = duration
        }
      }
      return best
    },
  }
}
