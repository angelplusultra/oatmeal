/**
 * JSON-schema grammars that emit compact (single-line) JSON.
 *
 * node-llama-cpp's `createGrammarForJsonSchema` forces newlines + 4-space indentation. With Gemma 4 E4B
 * that formatting fights the model's own tokenization: measured on a test meeting, it closed
 * `"actionItems": [` immediately in 2 of 3 runs, while compact JSON found every action item in 3 of 3
 * (scripts/eval-map.ts). Compact output is also fewer tokens.
 *
 * The generator that supports `allowNewLines` is internal to node-llama-cpp (not in its exports map), so
 * it is loaded by file path. If a future version moves it, we fall back to the default grammar.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Llama, LlamaGrammar } from 'node-llama-cpp'

type Generator = (schema: unknown, options: { allowNewLines?: boolean; scopePadSpaces?: number }) => string

let generator: Promise<Generator | null> | null = null

function loadGenerator(): Promise<Generator | null> {
  generator ??= (async () => {
    try {
      const dist = path.dirname(createRequire(import.meta.url).resolve('node-llama-cpp'))
      const mod = (await import(
        pathToFileURL(path.join(dist, 'utils/gbnfJson/getGbnfGrammarForGbnfJsonSchema.js')).href
      )) as {
        getGbnfGrammarForGbnfJsonSchema?: Generator
      }
      return mod.getGbnfGrammarForGbnfJsonSchema ?? null
    } catch (error) {
      console.warn('[llm] compact JSON grammar unavailable, using the default grammar:', error)
      return null
    }
  })()
  return generator
}

/** A grammar that only allows JSON matching `schema`, written on one line. Parse its output with JSON.parse. */
export async function createCompactJsonGrammar(llama: Llama, schema: object): Promise<LlamaGrammar> {
  const generate = await loadGenerator()
  if (generate) return llama.createGrammar({ grammar: generate(schema, { allowNewLines: false }) })
  return llama.createGrammarForJsonSchema(schema as never)
}
