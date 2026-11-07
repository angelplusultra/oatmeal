import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface DownloadFile {
  url: string
  dest: string
  size?: number | null
}

/**
 * Downloads files to disk (via a `.part` file, renamed on success), skipping files that already exist
 * with the expected size. Reports cumulative progress across the whole set.
 */
export async function downloadFiles(
  files: DownloadFile[],
  onProgress: (p: { file: string; loaded: number; total: number | null }) => void,
): Promise<void> {
  const total = files.every((f) => typeof f.size === 'number') ? files.reduce((s, f) => s + (f.size ?? 0), 0) : null
  let completed = 0
  let lastReport = 0
  for (const file of files) {
    const name = path.basename(file.dest)
    if (isComplete(file)) {
      completed += file.size ?? fs.statSync(file.dest).size
      continue
    }
    fs.mkdirSync(path.dirname(file.dest), { recursive: true })
    const res = await fetch(file.url)
    if (!res.ok || !res.body) throw new Error(`Download failed for ${name}: HTTP ${res.status}`)
    const part = `${file.dest}.part`
    let loaded = 0
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)
    body.on('data', (chunk: Buffer) => {
      loaded += chunk.length
      const now = Date.now()
      if (now - lastReport > 200) {
        lastReport = now
        onProgress({ file: name, loaded: completed + loaded, total })
      }
    })
    await pipeline(body, fs.createWriteStream(part))
    if (typeof file.size === 'number' && fs.statSync(part).size !== file.size) {
      fs.rmSync(part, { force: true })
      throw new Error(`Download of ${name} was incomplete`)
    }
    fs.renameSync(part, file.dest)
    completed += loaded
    onProgress({ file: name, loaded: completed, total })
  }
}

export function isComplete(file: DownloadFile): boolean {
  if (!fs.existsSync(file.dest)) return false
  return typeof file.size !== 'number' || fs.statSync(file.dest).size === file.size
}
