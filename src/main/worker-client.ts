import { utilityProcess, type UtilityProcess } from 'electron'
import { EventEmitter } from 'node:events'
import type { WorkerEvent, WorkerRequest, WorkerResponse } from '@shared/protocol'

type Payload<R, K extends keyof R> = R[K] extends { payload: infer P } ? P : never
type Result<R, K extends keyof R> = R[K] extends { result: infer T } ? T : never

/**
 * Typed request/response + events over an Electron utility process. The process is spawned lazily and
 * respawned on the next request if it dies; `onSpawn` re-initializes it.
 */
export class WorkerClient<R, E> {
  private proc: UtilityProcess | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private readonly events = new EventEmitter()

  constructor(
    private readonly entry: string,
    private readonly serviceName: string,
    private readonly onSpawn?: (client: WorkerClient<R, E>) => Promise<void>,
  ) {}

  on<K extends keyof E & string>(type: K, listener: (payload: E[K]) => void): () => void {
    this.events.on(type, listener)
    return () => this.events.off(type, listener)
  }

  /** Fires when the process exits unexpectedly. */
  onExit(listener: (code: number) => void): () => void {
    this.events.on('__exit', listener)
    return () => this.events.off('__exit', listener)
  }

  get running(): boolean {
    return this.proc !== null
  }

  private spawn(): Promise<void> {
    const proc = utilityProcess.fork(this.entry, [], { serviceName: this.serviceName, stdio: 'inherit' })
    this.proc = proc
    proc.on('message', (msg: WorkerResponse | WorkerEvent) => {
      if (msg?.kind === 'response') {
        const waiter = this.pending.get(msg.id)
        if (!waiter) return
        this.pending.delete(msg.id)
        if (msg.ok) waiter.resolve(msg.result)
        else waiter.reject(new Error(msg.error))
      } else if (msg?.kind === 'event') {
        this.events.emit(msg.type, msg.payload)
      }
    })
    proc.on('exit', (code) => {
      if (this.proc !== proc) return
      this.proc = null
      this.ready = null
      for (const waiter of this.pending.values()) waiter.reject(new Error(`${this.serviceName} stopped (exit ${code})`))
      this.pending.clear()
      this.events.emit('__exit', code)
    })
    return new Promise((resolve) => proc.once('spawn', () => resolve()))
  }

  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = this.spawn().then(() => this.onSpawn?.(this))
      this.ready.catch(() => {
        this.ready = null
      })
    }
    return this.ready
  }

  /** Sends a request without waiting for initialization (used by `onSpawn` itself). */
  send<K extends keyof R & string>(type: K, payload: Payload<R, K>): Promise<Result<R, K>> {
    const proc = this.proc
    if (!proc) return Promise.reject(new Error(`${this.serviceName} is not running`))
    const id = this.nextId++
    const msg: WorkerRequest = { kind: 'request', id, type, payload }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      proc.postMessage(msg)
    })
  }

  async request<K extends keyof R & string>(type: K, payload: Payload<R, K>): Promise<Result<R, K>> {
    await this.ensure()
    return this.send(type, payload)
  }

  kill() {
    this.proc?.kill()
    this.proc = null
    this.ready = null
  }
}
