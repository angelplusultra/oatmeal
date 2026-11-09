/**
 * Measures how reliably the map (extraction) step finds decisions and action items on a stored meeting,
 * comparing the production compact-JSON grammar with node-llama-cpp's default (indented) one.
 *   npx tsx scripts/eval-map.ts <oatmeal.db> <model.gguf> [runs=3]
 * Prints e.g. "4A/1D" per run: action items / decisions extracted.
 */
import { DatabaseSync } from 'node:sqlite'
import { getLlama, LlamaChatSession, type LlamaGrammar } from 'node-llama-cpp'
import { buildMapPrompt, MAP_SCHEMA, MAP_SYSTEM } from '../src/shared/summarize'
import { buildTurns, chunkTurns } from '../src/shared/transcript'
import type { Segment } from '../src/shared/types'
import { createCompactJsonGrammar } from '../src/workers/llm/grammar'

const [dbPath, modelPath, runsArg] = process.argv.slice(2)
const runs = Number(runsArg ?? 3)

const db = new DatabaseSync(dbPath)
const meeting = db.prepare('SELECT id, speaker_names FROM meetings ORDER BY started_at DESC LIMIT 1').get() as {
  id: string
  speaker_names: string
}
const segments = (
  db.prepare('SELECT * FROM segments WHERE meeting_id = ? ORDER BY start_ms').all(meeting.id) as Record<
    string,
    unknown
  >[]
).map(
  (r) =>
    ({
      id: r.id,
      meetingId: r.meeting_id,
      lineId: r.line_id,
      channel: r.channel,
      speaker: r.speaker,
      startMs: r.start_ms,
      endMs: r.end_ms,
      text: r.text,
      echo: r.echo === 1,
    }) as Segment,
)
const turns = buildTurns(segments, JSON.parse(meeting.speaker_names))

const llama = await getLlama()
const model = await llama.loadModel({ modelPath })
const context = await model.createContext({ contextSize: 8192 })
const sequence = context.getSequence()
const chunks = chunkTurns(turns, (t) => model.tokenize(t).length, 6000)

const variants: [string, LlamaGrammar][] = [
  ['default grammar (indented)', await llama.createGrammarForJsonSchema(MAP_SCHEMA as never)],
  ['compact grammar (production)', await createCompactJsonGrammar(llama, MAP_SCHEMA)],
]
for (const [name, grammar] of variants) {
  const results: string[] = []
  for (let i = 0; i < runs; i++) {
    let actions = 0
    let decisions = 0
    for (const chunk of chunks) {
      await sequence.clearHistory()
      const session = new LlamaChatSession({
        contextSequence: sequence,
        systemPrompt: MAP_SYSTEM,
        autoDisposeSequence: false,
      })
      const out = JSON.parse(
        await session.prompt(buildMapPrompt(chunk, chunks.length), { grammar, maxTokens: 2000, temperature: 0.2 }),
      )
      session.dispose({ disposeSequence: false })
      actions += out.actionItems.length
      decisions += out.decisions.length
    }
    results.push(`${actions}A/${decisions}D`)
  }
  console.log(`${name.padEnd(30)} ${results.join('  ')}`)
}
process.exit(0)
