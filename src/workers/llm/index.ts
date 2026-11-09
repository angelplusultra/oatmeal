/**
 * LLM utility process: downloads GGUF models, runs the notes pipeline, and unloads the model when idle so
 * Oatmeal doesn't hold gigabytes of memory between meetings.
 */
import fs from 'node:fs'
import path from 'node:path'
import { llmModel } from '@shared/models'
import type { LlmConfig, LlmEvents, LlmRequests } from '@shared/protocol'
import { summarizeMeeting } from '@shared/summarize'
import { createModelDownloader, type ModelDownloader } from 'node-llama-cpp'
import { emit, installCrashReporting, serve } from '../rpc'
import { EndpointLlm, LocalLlm } from './clients'

const send = <K extends keyof LlmEvents & string>(type: K, payload: LlmEvents[K]) => emit<LlmEvents, K>(type, payload)
installCrashReporting((message) => console.error(message))

const IDLE_UNLOAD_MS = 60_000

/** The loaded (or loading) client. Loading is shared, so a preload and a summarize never load twice. */
let loaded: { key: string; client: Promise<LocalLlm | EndpointLlm> } | null = null
let idleTimer: NodeJS.Timeout | null = null
let downloader: ModelDownloader | null = null
const jobs = new Map<string, AbortController>()

const modelPath = (modelsDir: string, modelId: Parameters<typeof llmModel>[0]) =>
  path.join(modelsDir, 'llm', llmModel(modelId).fileName)

async function clientFor(config: LlmConfig, jobId: string): Promise<LocalLlm | EndpointLlm> {
  const key = config.provider === 'local' ? `local:${config.modelPath}` : `endpoint:${config.baseUrl}:${config.model}`
  if (loaded?.key === key) return loaded.client
  await unload()
  let client: Promise<LocalLlm | EndpointLlm>
  if (config.provider === 'local') {
    if (!fs.existsSync(config.modelPath)) throw new Error('The notes model is not downloaded yet')
    send('progress', { jobId, stage: 'loading', done: 0, total: 1 })
    client = LocalLlm.load(config.modelPath, config.modelName)
  } else {
    if (!config.baseUrl || !config.model) throw new Error('Set the endpoint URL and model name in Settings')
    client = Promise.resolve(new EndpointLlm(config.baseUrl, config.model, config.apiKey))
  }
  const entry = { key, client }
  loaded = entry
  client.catch(() => {
    if (loaded === entry) loaded = null
  })
  return client
}

async function unload() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  const current = loaded
  loaded = null
  await current?.client.then((c) => c.dispose()).catch(() => {})
}

function scheduleUnload() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => void unload(), IDLE_UNLOAD_MS)
}

serve<LlmRequests>({
  'model-status'({ modelId, modelsDir }) {
    const file = modelPath(modelsDir, modelId)
    return { installed: fs.existsSync(file), path: file }
  },

  async download({ modelId, modelsDir }) {
    const info = llmModel(modelId)
    const dirPath = path.join(modelsDir, 'llm')
    fs.mkdirSync(dirPath, { recursive: true })
    downloader = await createModelDownloader({
      modelUri: info.uri,
      dirPath,
      fileName: info.fileName,
      skipExisting: true,
      deleteTempFileOnCancel: false,
      onProgress: ({ totalSize, downloadedSize }) =>
        send('download-progress', { file: info.fileName, loaded: downloadedSize, total: totalSize }),
    })
    try {
      return { path: await downloader.download() }
    } finally {
      downloader = null
    }
  },

  async 'cancel-download'() {
    await downloader?.cancel()
  },

  async preload({ config }) {
    await clientFor(config, 'preload')
    if (!jobs.size) scheduleUnload()
  },

  async summarize({ jobId, config, turns, cache }) {
    const controller = new AbortController()
    jobs.set(jobId, controller)
    if (idleTimer) clearTimeout(idleTimer)
    try {
      const client = await clientFor(config, jobId)
      const store = new Map(Object.entries(cache))
      const summary = await summarizeMeeting(turns, client, {
        signal: controller.signal,
        mapCache: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) },
        onProgress: (p) => send('progress', { jobId, ...p }),
      })
      return { summary, cache: Object.fromEntries(store) }
    } finally {
      jobs.delete(jobId)
      scheduleUnload()
    }
  },

  cancel({ jobId }) {
    jobs.get(jobId)?.abort()
  },

  unload() {
    return unload()
  },
})
