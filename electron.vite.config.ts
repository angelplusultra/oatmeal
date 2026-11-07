import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve('src/shared') }

/** Production-only CSP (the dev server needs inline scripts for React Fast Refresh). Nothing loads from the network. */
const csp = {
  name: 'oatmeal-csp',
  apply: 'build' as const,
  transformIndexHtml(html: string) {
    const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'"
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`)
  },
}

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rolldownOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // Utility processes: speech-to-text and the local LLM run outside the main process.
          'asr-worker': resolve('src/workers/asr/index.ts'),
          'llm-worker': resolve('src/workers/llm/index.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias: shared },
    build: {
      rolldownOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { ...shared, '@': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss(), csp],
    build: {
      rolldownOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          prompt: resolve('src/renderer/prompt.html'),
        },
      },
    },
  },
})
