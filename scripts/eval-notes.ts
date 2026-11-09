/**
 * Times the full notes pipeline on the latest meeting in a database, with Gemma 4 reasoning on vs off.
 *   npx tsx scripts/eval-notes.ts <oatmeal.db> <model.gguf> [maxSegments]
 * `maxSegments` truncates the transcript to simulate a short call.
 */
import { DatabaseSync } from 'node:sqlite'
import { Gemma4ChatWrapper, getLlama, LlamaChatSession, type LlamaGrammar } from 'node-llama-cpp'
import { type JsonSchema, type LlmClient, summarizeMeeting } from '../src/shared/summarize'
import { buildTurns } from '../src/shared/transcript'
import type { Segment } from '../src/shared/types'
import { createCompactJsonGrammar } from '../src/workers/llm/grammar'

const [dbPath, modelPath, maxArg] = process.argv.slice(2)
const db = new DatabaseSync(dbPath)
const meeting = db.prepare('SELECT id, speaker_names FROM meetings ORDER BY started_at DESC LIMIT 1').get() as {
  id: string
  speaker_names: string
}
let segments = (
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
if (maxArg) segments = segments.slice(0, Number(maxArg))
const turns = buildTurns(segments, JSON.parse(meeting.speaker_names))

const llama = await getLlama()
let t = Date.now()
const model = await llama.loadModel({ modelPath })
console.log(`model load: ${Date.now() - t} ms; transcript: ${turns.length} turns`)
const context = await model.createContext({ contextSize: 8192 })
const sequence = context.getSequence()
const grammars = new Map<JsonSchema, LlamaGrammar>()

for (const reasoning of [true, false]) {
  const calls: string[] = []
  const client: LlmClient = {
    modelName: 'eval',
    countTokens: (text) => model.tokenize(text).length,
    async generateJson({ system, prompt, schema, maxTokens }) {
      let grammar = grammars.get(schema)
      if (!grammar) grammars.set(schema, (grammar = await createCompactJsonGrammar(llama, schema)))
      await sequence.clearHistory()
      const session = new LlamaChatSession({
        contextSequence: sequence,
        systemPrompt: system,
        autoDisposeSequence: false,
        chatWrapper: new Gemma4ChatWrapper({ reasoning }),
      })
      const start = Date.now()
      const before = sequence.tokenMeter.getState()
      const text = await session.prompt(prompt, { grammar, maxTokens, temperature: 0.2 })
      const used = sequence.tokenMeter.diff(before)
      session.dispose({ disposeSequence: false })
      calls.push(`${Date.now() - start} ms (in ${used.usedInputTokens}, out ${used.usedOutputTokens})`)
      return JSON.parse(text)
    },
  }
  t = Date.now()
  const summary = await summarizeMeeting(turns, client)
  console.log(
    `reasoning=${reasoning}: total ${Date.now() - t} ms | calls: ${calls.join(' ; ')} | ${summary.actionItems.length} action items, ${summary.decisions.length} decisions`,
  )
}
process.exit(0)
