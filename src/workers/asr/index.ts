/**
 * ASR utility process. Owns the native Moonshine library, model downloads, the capture source, and one
 * streaming transcriber per channel. Audio never passes through the main process.
 */
import path from 'node:path'
import type { AsrEvents, AsrRequests, AudioSourceSpec } from '@shared/protocol'
import type { Channel } from '@shared/types'
import { type DownloadFile, downloadFiles, isComplete } from '../download'
import { emit, installCrashReporting, serve } from '../rpc'
import {
  FLAG_FORCE_UPDATE,
  MoonshineLibrary,
  type MoonshineManifest,
  type MoonshineStream,
  type MoonshineTranscriber,
} from './moonshine'
import { type AudioSource, openSource } from './sources'

const send = <K extends keyof AsrEvents & string>(type: K, payload: AsrEvents[K]) => emit<AsrEvents, K>(type, payload)
installCrashReporting((message) => send('error', { message }))

const SAMPLE_RATE = 16000
const PASS_INTERVAL_MS = 750
/** Coarser diarization cadence: ~0.55 extra cores instead of ~1.2 (measured on an M5 Pro). */
const DIARIZATION_OPTIONS = { diarization_analyze_cadence: '3', diarization_cluster_cadence: '10' }
const CLUSTER_WINDOW_SEC = 120

let lib: MoonshineLibrary | null = null
let modelsRoot = ''

function library(): MoonshineLibrary {
  if (!lib) throw new Error('ASR worker not initialized')
  return lib
}

function manifestFiles(manifest: MoonshineManifest): { dir: string; files: DownloadFile[] } {
  const group = manifest.groups[0]
  if (!group) throw new Error('empty model manifest')
  const dir = path.join(modelsRoot, 'moonshine', new URL(group.base_url).pathname)
  return {
    dir,
    files: group.files.map((f) => ({
      url: f.url ?? `${group.base_url.replace(/\/$/, '')}/${f.name}`,
      dest: path.join(dir, f.name),
      size: f.size ?? null,
    })),
  }
}

const sttModel = (arch: number) => manifestFiles(library().sttDependencies('en', arch))
const diarizationModel = () => manifestFiles(library().diarizationDependencies())

/** Streams one channel's audio into a Moonshine stream and turns snapshots into line events. */
class ChannelPipeline {
  private pending: Float32Array[] = []
  private fedSamples = 0
  private scanFrom = 0
  private readonly emitted = new Map<string, number | null>()
  private active = false
  private running = true
  private loop: Promise<void>

  constructor(
    readonly channel: Channel,
    private readonly transcriber: MoonshineTranscriber,
    private readonly stream: MoonshineStream,
    private readonly diarize: boolean,
  ) {
    this.loop = this.run()
  }

  push(samples: Float32Array) {
    this.pending.push(samples)
  }

  /** One pass every PASS_INTERVAL_MS, scheduled with timers so capture I/O is drained between passes. */
  private async run() {
    while (this.running) {
      await new Promise((r) => setTimeout(r, PASS_INTERVAL_MS))
      if (!this.running) break
      try {
        this.pass(0)
      } catch (error) {
        send('error', { message: `${this.channel} transcription: ${error instanceof Error ? error.message : error}` })
      }
    }
  }

  private flushAudio() {
    if (!this.pending.length) return
    const total = this.pending.reduce((n, a) => n + a.length, 0)
    const merged = new Float32Array(total)
    let offset = 0
    for (const a of this.pending) {
      merged.set(a, offset)
      offset += a.length
    }
    this.pending = []
    this.fedSamples += total
    this.stream.addAudio(merged, SAMPLE_RATE)
  }

  private pass(flags: number) {
    this.flushAudio()
    const { lines } = this.stream.transcribe(this.scanFrom, flags)
    const audioSeconds = this.fedSamples / SAMPLE_RATE
    let lastIncomplete = false
    for (const line of lines) {
      if (!line.complete) {
        lastIncomplete = true
        continue
      }
      const lineId = `${this.channel}:${line.id}`
      if (!this.emitted.has(line.id)) {
        const text = line.text().trim()
        const speakerIndex = this.diarize ? line.majoritySpeaker() : null
        this.emitted.set(line.id, speakerIndex)
        if (text) {
          send('line', {
            lineId,
            channel: this.channel,
            startMs: Math.round(line.startTime * 1000),
            endMs: Math.round((line.startTime + line.duration) * 1000),
            text,
            diarized: this.diarize,
            speakerIndex,
          })
        }
      } else if (this.diarize && line.speakersChanged) {
        const speakerIndex = line.majoritySpeaker()
        if (speakerIndex !== null && speakerIndex !== this.emitted.get(line.id)) {
          this.emitted.set(line.id, speakerIndex)
          send('speaker', { lineId, speakerIndex })
        }
      }
    }
    // Lines that are complete and (with diarization) older than the re-clustering window never change
    // again, so later passes can skip them.
    const frozenBefore = this.diarize ? audioSeconds - CLUSTER_WINDOW_SEC - 15 : Infinity
    for (const line of lines) {
      if (line.index !== this.scanFrom || !line.complete || line.startTime + line.duration > frozenBefore) break
      this.scanFrom++
    }
    if (lastIncomplete !== this.active) {
      this.active = lastIncomplete
      send('activity', { channel: this.channel, active: lastIncomplete })
    }
  }

  /** Stops the loop, transcribes whatever is buffered, and releases native resources. */
  async finish() {
    this.running = false
    await this.loop
    try {
      this.flushAudio()
      this.stream.stop()
      this.pass(FLAG_FORCE_UPDATE)
    } catch (error) {
      send('error', { message: `${this.channel} final pass: ${error instanceof Error ? error.message : error}` })
    }
    if (this.active) send('activity', { channel: this.channel, active: false })
    this.stream.free()
    this.transcriber.free()
  }
}

interface Session {
  source: AudioSource
  pipelines: Map<Channel, ChannelPipeline>
}

let session: Session | null = null

async function startSession(arch: number, separateSpeakers: boolean, spec: AudioSourceSpec) {
  if (session) throw new Error('already recording')
  const stt = sttModel(arch)
  if (!stt.files.every(isComplete)) throw new Error('The speech model is not downloaded yet')
  const base = { decode_incomplete_lines: 'false', return_audio_data: 'false' }

  const channels: Channel[] =
    spec.kind === 'files' ? (['mic', 'system'] as const).filter((c) => !!spec[c]) : ['mic', 'system']
  const pipelines = new Map<Channel, ChannelPipeline>()
  for (const channel of channels) {
    const diarize = channel === 'system' && separateSpeakers
    let options: Record<string, string> = base
    if (diarize) {
      const dia = diarizationModel()
      if (dia.files.every(isComplete)) {
        options = { ...base, identify_speakers: 'true', diarization_model_dir: dia.dir, ...DIARIZATION_OPTIONS }
      } else {
        send('error', { message: 'Speaker separation model missing; labelling remote audio as "Them".' })
      }
    }
    const transcriber = library().loadTranscriber(stt.dir, arch, options)
    const stream = transcriber.createStream()
    pipelines.set(channel, new ChannelPipeline(channel, transcriber, stream, 'identify_speakers' in options))
  }

  const source = openSource(spec, {
    onAudio: (channel, samples) => pipelines.get(channel)?.push(samples),
    onEvent: (event) => send('capture', event),
    onEnded: (reason) => send('source-ended', { reason }),
  })
  session = { source, pipelines }
}

async function stopSession() {
  const current = session
  session = null
  if (!current) return
  await current.source.stop()
  await Promise.all([...current.pipelines.values()].map((p) => p.finish()))
}

serve<AsrRequests>({
  init({ libDir, modelsDir }) {
    lib = new MoonshineLibrary(libDir)
    modelsRoot = modelsDir
    return { version: lib.version() }
  },
  'model-status'({ arch }) {
    return {
      installed: sttModel(arch).files.every(isComplete),
      diarizationInstalled: diarizationModel().files.every(isComplete),
    }
  },
  async download({ arch, diarization }) {
    const files = [...sttModel(arch).files, ...(diarization ? diarizationModel().files : [])]
    await downloadFiles(files, (p) => send('download-progress', p))
  },
  start({ arch, separateSpeakers, source }) {
    return startSession(arch, separateSpeakers, source)
  },
  stop() {
    return stopSession()
  },
})
