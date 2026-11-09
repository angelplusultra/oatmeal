import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FoundModel } from '@shared/types'

/** Where other local-AI tools keep their GGUFs. Missing folders are skipped. */
export function modelRoots(): { dir: string; source: string }[] {
  const home = os.homedir()
  const cache =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Caches')
      : (process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'))
  return [
    { dir: path.join(home, '.lmstudio', 'models'), source: 'LM Studio' },
    { dir: path.join(home, '.cache', 'lm-studio', 'models'), source: 'LM Studio' },
    { dir: path.join(cache, 'llama.cpp'), source: 'llama.cpp' },
    { dir: path.join(home, '.node-llama-cpp', 'models'), source: 'node-llama-cpp' },
    {
      dir:
        process.env.HF_HUB_CACHE ?? path.join(process.env.HF_HOME ?? path.join(home, '.cache', 'huggingface'), 'hub'),
      source: 'Hugging Face',
    },
  ]
}

/**
 * Finds copies of `fileName` under `roots`. llama.cpp and node-llama-cpp prefix downloads with the repo
 * (`unsloth_gemma-4-E4B-it-GGUF_gemma-4-E4B-it-Q4_K_M.gguf`), so a `_`-prefixed match counts too.
 */
export function findModelFiles(fileName: string, roots = modelRoots()): FoundModel[] {
  const found: FoundModel[] = []
  for (const { dir, source } of roots) {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir, { recursive: true }) as string[]
    } catch {
      continue
    }
    for (const rel of entries) {
      const base = path.basename(rel)
      if (base !== fileName && !base.endsWith(`_${fileName}`)) continue
      const file = path.join(dir, rel)
      // Skip partial downloads and broken Hugging Face symlinks.
      try {
        if (fs.statSync(file).size > 100e6) found.push({ path: file, source })
      } catch {}
    }
  }
  return found
}
