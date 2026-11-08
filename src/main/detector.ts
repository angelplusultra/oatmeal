/**
 * Meeting detection: runs `oatmeal-audio detect` (on Linux, `pactl subscribe` + pulse.ts) and turns "these processes are using the mic / playing
 * audio" into per-app state, keeping only known meeting apps and browsers.
 *
 * - `started`: a meeting app has held the mic for START_DEBOUNCE_MS (time to offer transcription).
 * - `stopped`: it released the mic. The orchestrator then uses `isPlaying` and speech activity to tell
 *   "left the call" from "muted" (see shared/call-end.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { matchMeetingApp } from '@shared/models'
import type { DetectedApp } from '@shared/types'
import { helperAvailable } from './helper'
import { listAudioProcesses, type AudioProcess } from './pulse'

/** A meeting app must hold the mic this long before we prompt (filters blips like device probing). */
const START_DEBOUNCE_MS = 2000

export interface DetectedMeetingApp extends DetectedApp {
  /** Friendly app name, e.g. "Zoom" or "Google Chrome". */
  name: string
  browser: boolean
}

interface MicEntry {
  app: DetectedMeetingApp
  timer: NodeJS.Timeout | null
  announced: boolean
}

export class MeetingDetector {
  private child: ChildProcess | null = null
  private readonly events = new EventEmitter()
  private readonly mic = new Map<string, MicEntry>()
  /** App name → when it last started or stopped playing audio. */
  private readonly playing = new Map<string, { playing: boolean; since: number }>()
  private stopped = true
  private restartDelay = 1000
  private refreshTimer: NodeJS.Timeout | null = null
  private refreshing: Promise<void> = Promise.resolve()

  constructor(
    private readonly helperPath: string,
    /** PIDs of Oatmeal's own processes (e.g. the capture helper), which must never trigger a prompt. */
    private readonly ownPids: () => Set<number>,
  ) {}

  onStarted(listener: (app: DetectedMeetingApp) => void) {
    this.events.on('started', listener)
  }

  onStopped(listener: (app: DetectedMeetingApp) => void) {
    this.events.on('stopped', listener)
  }

  /** The app holds the mic and has been announced (debounced). */
  isActive(name: string): boolean {
    return this.mic.get(name)?.announced ?? false
  }

  /** The app holds the mic right now, debounce or not. */
  hasMic(name: string): boolean {
    return this.mic.has(name)
  }

  isPlaying(name: string): boolean {
    return this.playing.get(name)?.playing ?? false
  }

  /** When the app stopped playing audio, or null if it is playing (or we never saw it play). */
  playingStoppedAt(name: string): number | null {
    const state = this.playing.get(name)
    return state && !state.playing ? state.since : null
  }

  start() {
    if (!helperAvailable(this.helperPath) || this.child) return
    this.stopped = false
    // Linux: `pactl subscribe` prints a line per PipeWire change; re-read the stream lists after each burst.
    const linux = process.platform === 'linux'
    const child = linux
      ? spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] })
      : spawn(this.helperPath, ['detect', '--interval-ms', '500'], { stdio: ['pipe', 'pipe', 'ignore'] })
    this.child = child
    child.on('error', (error) => console.error('[detector]', error.message))
    if (linux) this.refreshSoon()
    let buffer = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (linux) {
          if (/sink-input|source-output/.test(line)) this.refreshSoon()
          continue
        }
        try {
          const msg = JSON.parse(line) as { type: string; processes: AudioProcess[] }
          if (msg.type === 'audio-users') this.update(msg.processes)
        } catch {
          // ignore malformed lines
        }
      }
    })
    child.on('exit', () => {
      if (this.child === child) this.child = null
      if (this.stopped) return
      // The helper should run forever; restart it with backoff if it dies.
      setTimeout(() => this.start(), this.restartDelay)
      this.restartDelay = Math.min(this.restartDelay * 2, 60_000)
    })
  }

  private refreshSoon() {
    if (this.refreshTimer) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      // Chained so snapshots apply in order.
      this.refreshing = this.refreshing
        .then(() => listAudioProcesses())
        .then((processes) => {
          if (!this.stopped) this.update(processes)
        })
        .catch((error) => console.error('[detector] pactl failed:', error.message))
    }, 200)
  }

  stop() {
    this.stopped = true
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.child?.stdin?.end()
    this.child?.kill()
    this.child = null
    for (const entry of this.mic.values()) if (entry.timer) clearTimeout(entry.timer)
    this.mic.clear()
    this.playing.clear()
  }

  private update(processes: AudioProcess[]) {
    this.restartDelay = 1000
    const own = this.ownPids()
    const withMic = new Map<string, DetectedMeetingApp>()
    const outputting = new Set<string>()
    for (const p of processes) {
      if (own.has(p.pid)) continue
      const match = matchMeetingApp(p.bundleId)
      if (!match) continue
      if (p.output) outputting.add(match.name)
      if (p.input && !withMic.has(match.name)) {
        withMic.set(match.name, { pid: p.pid, bundleId: p.bundleId, name: match.name, browser: match.browser })
      }
    }

    const now = Date.now()
    for (const name of new Set([...this.playing.keys(), ...outputting])) {
      const isPlaying = outputting.has(name)
      if (this.playing.get(name)?.playing !== isPlaying) this.playing.set(name, { playing: isPlaying, since: now })
    }

    for (const [name, app] of withMic) {
      if (this.mic.has(name)) continue
      const entry: MicEntry = { app, announced: false, timer: null }
      entry.timer = setTimeout(() => {
        entry.timer = null
        entry.announced = true
        this.events.emit('started', app)
      }, START_DEBOUNCE_MS)
      this.mic.set(name, entry)
    }

    for (const [name, entry] of this.mic) {
      if (withMic.has(name)) continue
      if (entry.timer) clearTimeout(entry.timer)
      this.mic.delete(name)
      if (entry.announced) this.events.emit('stopped', entry.app)
    }
  }
}
