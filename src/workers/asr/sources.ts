/** Audio sources for the ASR worker: the native capture helper, or WAV files for development/testing. */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import type { AudioSourceSpec } from '@shared/protocol'
import type { Channel } from '@shared/types'

export interface AudioSourceCallbacks {
  onAudio(channel: Channel, samples: Float32Array): void
  onEvent(event: Record<string, unknown>): void
  onEnded(reason: string): void
}

export interface AudioSource {
  stop(): Promise<void>
}

export function openSource(spec: AudioSourceSpec, cb: AudioSourceCallbacks): AudioSource {
  return spec.kind === 'helper' ? new HelperSource(spec.helperPath, spec.excludePids, cb) : new FileSource(spec, cb)
}

const CHANNELS: Record<number, Channel> = { 0: 'mic', 1: 'system' }

/** Spawns `oatmeal-audio capture` and parses its framed PCM stream. See native/macos/.../main.swift. */
class HelperSource implements AudioSource {
  private readonly child: ChildProcess
  private buffer: Buffer = Buffer.alloc(0)
  private stopping = false

  constructor(helperPath: string, excludePids: number[], private readonly cb: AudioSourceCallbacks) {
    const args = ['capture', ...excludePids.flatMap((pid) => ['--exclude-pid', String(pid)])]
    this.child = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout!.on('data', (chunk: Buffer) => this.onData(chunk))
    let errBuf = ''
    this.child.stderr!.on('data', (chunk: Buffer) => {
      errBuf += chunk.toString('utf8')
      let nl: number
      while ((nl = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, nl).trim()
        errBuf = errBuf.slice(nl + 1)
        if (!line) continue
        try {
          cb.onEvent(JSON.parse(line))
        } catch {
          cb.onEvent({ type: 'log', message: line })
        }
      }
    })
    this.child.on('error', (error) => cb.onEvent({ type: 'error', message: `capture helper: ${error.message}` }))
    this.child.on('exit', (code, signal) => {
      if (!this.stopping) cb.onEnded(`capture helper exited (${signal ?? code})`)
    })
  }

  private onData(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    let offset = 0
    while (this.buffer.length - offset >= 5) {
      const channel = CHANNELS[this.buffer[offset]]
      const count = this.buffer.readUInt32LE(offset + 1)
      const end = offset + 5 + count * 2
      if (this.buffer.length < end) break
      const samples = new Float32Array(count)
      for (let i = 0; i < count; i++) samples[i] = this.buffer.readInt16LE(offset + 5 + i * 2) / 32768
      if (channel) this.cb.onAudio(channel, samples)
      offset = end
    }
    this.buffer = offset ? this.buffer.subarray(offset) : this.buffer
    if (this.buffer.length === 0) this.buffer = Buffer.alloc(0)
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()))
    this.child.stdin?.end() // the helper exits when stdin closes
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 2000)
    await exited
    clearTimeout(timer)
  }
}

/** Plays WAV files in (accelerated) real time as the mic and/or system channels. */
class FileSource implements AudioSource {
  private timer: NodeJS.Timeout | null = null

  constructor(spec: Extract<AudioSourceSpec, { kind: 'files' }>, cb: AudioSourceCallbacks) {
    const tracks: { channel: Channel; samples: Float32Array; pos: number }[] = []
    if (spec.mic) tracks.push({ channel: 'mic', samples: readWav16k(spec.mic), pos: 0 })
    if (spec.system) tracks.push({ channel: 'system', samples: readWav16k(spec.system), pos: 0 })
    const chunk = 1600 // 100 ms
    const interval = Math.max(5, Math.round(100 / Math.max(spec.speed, 0.1)))
    cb.onEvent({ type: 'started', mic: !!spec.mic, system: !!spec.system, source: 'files' })
    this.timer = setInterval(() => {
      let remaining = false
      for (const t of tracks) {
        if (t.pos >= t.samples.length) continue
        cb.onAudio(t.channel, t.samples.subarray(t.pos, t.pos + chunk))
        t.pos += chunk
        remaining ||= t.pos < t.samples.length
      }
      if (!remaining) {
        this.clear()
        cb.onEnded('test audio finished')
      }
    }, interval)
  }

  private clear() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async stop(): Promise<void> {
    this.clear()
  }
}

/** Reads a 16-bit PCM WAV, downmixes to mono and linearly resamples to 16 kHz. */
export function readWav16k(file: string): Float32Array {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file} is not a WAV file`)
  let offset = 12
  let rate = 16000
  let channels = 1
  let bits = 16
  let data: Buffer | null = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10)
      rate = buf.readUInt32LE(offset + 12)
      bits = buf.readUInt16LE(offset + 22)
    } else if (id === 'data') {
      data = buf.subarray(offset + 8, Math.min(buf.length, offset + 8 + size))
    }
    offset += 8 + size + (size % 2)
  }
  if (!data || bits !== 16) throw new Error(`${file}: only 16-bit PCM WAV is supported`)
  const frames = Math.floor(data.length / 2 / channels)
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2)
    mono[i] = sum / channels / 32768
  }
  if (rate === 16000) return mono
  const outLength = Math.floor((frames * 16000) / rate)
  const out = new Float32Array(outLength)
  const step = rate / 16000
  for (let i = 0; i < outLength; i++) {
    const x = i * step
    const i0 = Math.floor(x)
    const frac = x - i0
    out[i] = mono[i0] * (1 - frac) + (mono[Math.min(i0 + 1, frames - 1)] ?? 0) * frac
  }
  return out
}
