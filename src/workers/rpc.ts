/** Request/response + events over an Electron utility process's parentPort. */
import type {} from 'electron'
import type { WorkerEvent, WorkerRequest, WorkerResponse } from '@shared/protocol'

type Handlers<R> = { [K in keyof R]: (payload: R[K] extends { payload: infer P } ? P : never) => Promise<unknown> | unknown }

export function serve<R>(handlers: Handlers<R>): void {
  process.parentPort.on('message', async (event) => {
    const msg = event.data as WorkerRequest
    if (msg?.kind !== 'request') return
    const handler = (handlers as Record<string, (p: unknown) => unknown>)[msg.type]
    let response: WorkerResponse
    try {
      if (!handler) throw new Error(`unknown request ${msg.type}`)
      response = { kind: 'response', id: msg.id, ok: true, result: await handler(msg.payload) }
    } catch (error) {
      response = { kind: 'response', id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    process.parentPort.postMessage(response)
  })
}

export function emit<E, K extends keyof E & string>(type: K, payload: E[K]): void {
  const msg: WorkerEvent = { kind: 'event', type, payload }
  process.parentPort.postMessage(msg)
}

/** Keeps the process alive and reports crashes to the parent before dying. */
export function installCrashReporting(emitError: (message: string) => void): void {
  process.on('uncaughtException', (error) => {
    emitError(`uncaught: ${error.stack ?? error.message}`)
  })
  process.on('unhandledRejection', (reason) => {
    emitError(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
  })
}
