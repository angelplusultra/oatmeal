import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { findModelFiles } from './find-models'

test('finds exact and repo-prefixed copies, skips small and unrelated files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oatmeal-find-'))
  const write = (rel: string, size: number) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), '')
    fs.truncateSync(path.join(root, rel), size) // sparse, so this costs no disk
  }
  write('lmstudio-community/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf', 200e6)
  write('unsloth_gemma-4-E4B-it-GGUF_gemma-4-E4B-it-Q4_K_M.gguf', 200e6)
  write('partial/gemma-4-E4B-it-Q4_K_M.gguf', 1e6)
  write('other/xgemma-4-E4B-it-Q4_K_M.gguf', 200e6)

  const found = findModelFiles('gemma-4-E4B-it-Q4_K_M.gguf', [
    { dir: root, source: 'Test' },
    { dir: path.join(root, 'missing'), source: 'Missing' },
  ])
  expect(found.map((f) => path.relative(root, f.path)).sort()).toEqual([
    'lmstudio-community/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf',
    'unsloth_gemma-4-E4B-it-GGUF_gemma-4-E4B-it-Q4_K_M.gguf',
  ])
  fs.rmSync(root, { recursive: true })
})
