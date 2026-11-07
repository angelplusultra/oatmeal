/**
 * Meeting notes pipeline. Pure logic; the LLM is injected so this runs against node-llama-cpp, an
 * OpenAI-compatible endpoint, or a fake in tests.
 *
 * - Transcript fits in one chunk (most calls): ONE pass writes the notes directly, then VERIFY (code).
 *   Generation speed (~37 tok/s for Gemma 4 E4B on an M5 Pro) dominates, so one pass is ~2× faster.
 * - Longer: MAP (extract per chunk) → VERIFY → REDUCE (combine) → resolve back to verified notes.
 */
import { wordSimilarity } from './echo'
import { chunkTurns, formatTimestamp, parseTimestamp, type Chunk, type Turn } from './transcript'
import type { ActionItem, Decision, KeyPointGroup, MeetingSummary } from './types'

/** Bump when prompts or schemas change, so cached map results are not reused across versions. */
export const PROMPT_VERSION = 2

export type JsonSchema = Record<string, unknown>

export interface LlmClient {
  /** Identifies the model for caching and display. */
  readonly modelName: string
  countTokens(text: string): number
  generateJson(request: { system: string; prompt: string; schema: JsonSchema; maxTokens: number }): Promise<unknown>
}

export interface SummarizeProgress {
  stage: 'map' | 'reduce'
  done: number
  total: number
}

export interface SummarizeOptions {
  /** Max transcript tokens per chunk. */
  chunkTokens?: number
  overlapTurns?: number
  onProgress?: (progress: SummarizeProgress) => void
  signal?: AbortSignal
  mapCache?: { get(key: string): unknown; set(key: string, value: unknown): void }
}

export const DEFAULT_CHUNK_TOKENS = 6000

export const MAP_SYSTEM = [
  'You are a meticulous meeting note-taker.',
  'You only write down what was actually said in the transcript. Never invent names, dates, numbers, decisions or tasks.',
  'Each transcript line starts with a [mm:ss] timestamp and the speaker\'s name. "You" is the person taking these notes.',
].join(' ')

const ts = { type: 'string', description: 'Timestamp of the transcript line, copied exactly, e.g. "12:34"', maxLength: 10 }
const nullableString = (description: string, maxLength = 120) => ({ type: ['string', 'null'], description, maxLength })

export const MAP_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 80 },
          points: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 300 } },
        },
        required: ['title', 'points'],
        additionalProperties: false,
      },
    },
    decisions: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 300 }, ts },
        required: ['text', 'ts'],
        additionalProperties: false,
      },
    },
    actionItems: {
      type: 'array',
      maxItems: 15,
      items: {
        type: 'object',
        properties: {
          task: { type: 'string', maxLength: 300 },
          owner: nullableString('Who is responsible, as named in the transcript, or null', 60),
          due: nullableString('Deadline as stated, or null', 60),
          ts,
        },
        required: ['task', 'owner', 'due', 'ts'],
        additionalProperties: false,
      },
    },
    openQuestions: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } },
  },
  required: ['topics', 'decisions', 'actionItems', 'openQuestions'],
  additionalProperties: false,
}

/** Single-pass schema: the final notes, with timestamps on decisions and action items so they can be verified. */
export const NOTES_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 80 },
    tldr: { type: 'string', maxLength: 600 },
    keyPoints: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string', maxLength: 80 },
          points: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 300 } },
        },
        required: ['topic', 'points'],
        additionalProperties: false,
      },
    },
    decisions: (MAP_SCHEMA.properties as Record<string, unknown>).decisions,
    actionItems: (MAP_SCHEMA.properties as Record<string, unknown>).actionItems,
    openQuestions: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } },
  },
  required: ['title', 'tldr', 'keyPoints', 'decisions', 'actionItems', 'openQuestions'],
  additionalProperties: false,
}

interface SinglePassNotes {
  title: string
  tldr: string
  keyPoints: KeyPointGroup[]
  decisions: ChunkNotes['decisions']
  actionItems: ChunkNotes['actionItems']
  openQuestions: string[]
}

export function buildSinglePassPrompt(chunk: Chunk): string {
  return `This is a meeting transcript (${formatTimestamp(chunk.startMs)}–${formatTimestamp(chunk.endMs)}).

<transcript>
${chunk.text}
</transcript>

Write the meeting notes:
- title: a short, specific title for the meeting (at most 8 words).
- tldr: 1-3 sentences on what the meeting was about and its outcome. For a very short call, one sentence is enough.
- keyPoints: the main topics, each with 1-5 short factual points. Keep specific numbers, names and dates that were mentioned.
- decisions: things that were explicitly agreed or decided. "ts" is the timestamp of the line where it was decided.
- actionItems: concrete tasks someone committed to or was asked to do. "owner" is the person responsible as named in the transcript ("You" for the note-taker) or null if unclear. "due" is the deadline as stated, or null. "ts" is the timestamp of the line where it was said.
- openQuestions: questions or issues raised but not resolved.
Use empty arrays when there is nothing for a field. Do not repeat the same item twice.`
}

const idList = (prefix: string) => ({
  type: 'array',
  maxItems: 8,
  items: { type: 'string', maxLength: 6 },
  description: `Ids of the source notes this is based on, e.g. ["${prefix}1", "${prefix}3"]`,
})

export const REDUCE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 80 },
    tldr: { type: 'string', maxLength: 600 },
    keyPoints: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string', maxLength: 80 },
          points: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 300 } },
        },
        required: ['topic', 'points'],
        additionalProperties: false,
      },
    },
    decisions: {
      type: 'array',
      maxItems: 15,
      items: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 300 }, ids: idList('D') },
        required: ['text', 'ids'],
        additionalProperties: false,
      },
    },
    actionItems: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'object',
        properties: {
          task: { type: 'string', maxLength: 300 },
          owner: nullableString('Who is responsible, or null', 60),
          due: nullableString('Deadline as stated, or null', 60),
          ids: idList('A'),
        },
        required: ['task', 'owner', 'due', 'ids'],
        additionalProperties: false,
      },
    },
    openQuestions: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 300 } },
  },
  required: ['title', 'tldr', 'keyPoints', 'decisions', 'actionItems', 'openQuestions'],
  additionalProperties: false,
}

export interface ChunkNotes {
  topics: { title: string; points: string[] }[]
  decisions: { text: string; ts: string }[]
  actionItems: { task: string; owner: string | null; due: string | null; ts: string }[]
  openQuestions: string[]
}

interface ReduceOutput {
  title: string
  tldr: string
  keyPoints: KeyPointGroup[]
  decisions: { text: string; ids: string[] }[]
  actionItems: { task: string; owner: string | null; due: string | null; ids: string[] }[]
  openQuestions: string[]
}

/** A note that survived verification, tagged with an id the reduce step can cite. */
interface VerifiedDecision {
  id: string
  text: string
  ts: number
}
interface VerifiedAction {
  id: string
  task: string
  owner: string | null
  due: string | null
  ts: number
}
interface VerifiedNotes {
  topics: { title: string; points: string[]; startMs: number; endMs: number }[]
  decisions: VerifiedDecision[]
  actionItems: VerifiedAction[]
  openQuestions: { id: string; text: string }[]
}

export function buildMapPrompt(chunk: Chunk, total: number): string {
  const part = total > 1 ? `This is part ${chunk.index + 1} of ${total} of a meeting transcript ` : 'This is a meeting transcript '
  return `${part}(${formatTimestamp(chunk.startMs)}–${formatTimestamp(chunk.endMs)}).

<transcript>
${chunk.text}
</transcript>

Extract from this transcript:
- topics: the main subjects discussed, each with 1-5 short factual points. Keep specific numbers, names and dates that were mentioned.
- decisions: things that were explicitly agreed or decided. "ts" is the timestamp of the line where it was decided.
- actionItems: concrete tasks someone committed to or was asked to do. "owner" is the person responsible as named in the transcript ("You" for the note-taker) or null if unclear. "due" is the deadline as stated, or null. "ts" is the timestamp of the line where it was said.
- openQuestions: questions or issues raised but not resolved.
Use empty arrays when there is nothing for a field. Do not repeat the same item twice.`
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * Drops items the model could not have read in this chunk: decisions and action items must cite a
 * timestamp inside the chunk, and an owner must be a participant or a name that appears in the text.
 */
export function verifyChunkNotes(notes: ChunkNotes, chunk: Chunk, slackMs = 30_000) {
  const inRange = (ms: number | null): ms is number =>
    ms !== null && ms >= chunk.startMs - slackMs && ms <= chunk.endMs + slackMs
  const haystack = normalize(chunk.text)
  const labels = new Set(chunk.turns.map((t) => normalize(t.label)))
  const cleanOwner = (owner: string | null): string | null => {
    if (!owner?.trim()) return null
    const n = normalize(owner)
    if (['you', 'me', 'i', 'myself'].includes(n)) return 'You'
    if (labels.has(n)) return owner.trim()
    return n && haystack.includes(n) ? owner.trim() : null
  }
  const cleanDue = (due: string | null): string | null => {
    if (!due?.trim()) return null
    const words = normalize(due).split(' ').filter((w) => w.length > 2)
    // Keep the deadline only if at least one of its meaningful words was actually said.
    return words.length === 0 || words.some((w) => haystack.includes(w)) ? due.trim() : null
  }

  return {
    topics: notes.topics
      .map((t) => ({ title: t.title.trim(), points: t.points.map((p) => p.trim()).filter(Boolean) }))
      .filter((t) => t.title || t.points.length),
    decisions: notes.decisions
      .map((d) => ({ text: d.text.trim(), ts: parseTimestamp(d.ts) }))
      .filter((d): d is { text: string; ts: number } => !!d.text && inRange(d.ts)),
    actionItems: notes.actionItems
      .map((a) => ({ task: a.task.trim(), owner: cleanOwner(a.owner), due: cleanDue(a.due), ts: parseTimestamp(a.ts) }))
      .filter((a): a is { task: string; owner: string | null; due: string | null; ts: number } => !!a.task && inRange(a.ts)),
    openQuestions: notes.openQuestions.map((q) => q.trim()).filter(Boolean),
  }
}

function mergeVerified(perChunk: { chunk: Chunk; notes: ReturnType<typeof verifyChunkNotes> }[]): VerifiedNotes {
  const out: VerifiedNotes = { topics: [], decisions: [], actionItems: [], openQuestions: [] }
  const seen = new Set<string>()
  const firstTime = (kind: string, text: string) => {
    const key = `${kind}:${normalize(text)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
  for (const { chunk, notes } of perChunk) {
    for (const t of notes.topics) out.topics.push({ ...t, startMs: chunk.startMs, endMs: chunk.endMs })
    for (const d of notes.decisions) {
      if (firstTime('d', d.text)) out.decisions.push({ id: `D${out.decisions.length + 1}`, ...d })
    }
    for (const a of notes.actionItems) {
      if (firstTime('a', a.task)) out.actionItems.push({ id: `A${out.actionItems.length + 1}`, ...a })
    }
    for (const q of notes.openQuestions) {
      if (firstTime('q', q)) out.openQuestions.push({ id: `Q${out.openQuestions.length + 1}`, text: q })
    }
  }
  return out
}

export function buildReducePrompt(notes: VerifiedNotes, participants: string[]): string {
  const topics = notes.topics.length
    ? notes.topics
        .map((t) => `- [${formatTimestamp(t.startMs)}–${formatTimestamp(t.endMs)}] ${t.title}${t.points.length ? `: ${t.points.join('; ')}` : ''}`)
        .join('\n')
    : '(none)'
  const decisions = notes.decisions.length
    ? notes.decisions.map((d) => `${d.id} [${formatTimestamp(d.ts)}] ${d.text}`).join('\n')
    : '(none)'
  const actions = notes.actionItems.length
    ? notes.actionItems
        .map((a) => `${a.id} [${formatTimestamp(a.ts)}] ${a.owner ?? 'unassigned'}: ${a.task}${a.due ? ` (due: ${a.due})` : ''}`)
        .join('\n')
    : '(none)'
  const questions = notes.openQuestions.length ? notes.openQuestions.map((q) => `${q.id} ${q.text}`).join('\n') : '(none)'

  return `Below are notes taken from each part of a meeting, in order. Combine them into the final meeting notes.

PARTICIPANTS: ${participants.join(', ')}

TOPICS:
${topics}

DECISIONS:
${decisions}

ACTION ITEMS:
${actions}

OPEN QUESTIONS:
${questions}

Write:
- title: a short, specific title for the meeting (at most 8 words).
- tldr: 1-3 sentences summarizing what the meeting was about and its outcome.
- keyPoints: group the topics into at most 6 sections, merging duplicates across parts. 1-5 concise points each.
- decisions: the decisions with duplicates merged. "ids" lists the D-ids each one is based on.
- actionItems: the action items with duplicates merged. "ids" lists the A-ids each one is based on. Keep owners and due dates from the notes.
- openQuestions: open questions that were not answered later in the meeting.
Only use information from the notes above. Use empty arrays when a section has nothing.`
}

function resolveReduce(out: ReduceOutput, notes: VerifiedNotes): Pick<MeetingSummary, 'decisions' | 'actionItems'> {
  const decisionsById = new Map(notes.decisions.map((d) => [d.id.toUpperCase(), d]))
  const actionsById = new Map(notes.actionItems.map((a) => [a.id.toUpperCase(), a]))

  const decisions: Decision[] = []
  for (const d of out.decisions) {
    const sources = d.ids.map((id) => decisionsById.get(id.trim().toUpperCase())).filter((x) => !!x)
    // A decision the reduce step cannot trace back to a verified note is dropped.
    if (!sources.length || !d.text.trim()) continue
    decisions.push({ text: d.text.trim(), ts: Math.min(...sources.map((s) => s.ts)) })
  }

  const actionItems: ActionItem[] = []
  for (const a of out.actionItems) {
    const sources = a.ids.map((id) => actionsById.get(id.trim().toUpperCase())).filter((x) => !!x)
    if (!sources.length || !a.task.trim()) continue
    const knownOwners = sources.map((s) => s.owner).filter((o): o is string => !!o)
    const owner =
      a.owner && knownOwners.some((o) => normalize(o) === normalize(a.owner!)) ? a.owner.trim() : (knownOwners[0] ?? null)
    const due = sources.find((s) => s.due)?.due ?? null
    actionItems.push({ task: a.task.trim(), owner, due, ts: Math.min(...sources.map((s) => s.ts)), done: false })
  }

  // Never lose a verified action item just because the reduce step forgot it.
  const cited = new Set(out.actionItems.flatMap((a) => a.ids.map((id) => id.trim().toUpperCase())))
  for (const a of notes.actionItems) {
    if (!cited.has(a.id.toUpperCase())) {
      actionItems.push({ task: a.task, owner: a.owner, due: a.due, ts: a.ts, done: false })
    }
  }
  actionItems.sort((x, y) => (x.ts ?? 0) - (y.ts ?? 0))
  decisions.sort((x, y) => (x.ts ?? 0) - (y.ts ?? 0))
  return { decisions: mergeNearDuplicates(decisions, (d) => d.text), actionItems: mergeActionItems(actionItems) }
}

const DUPLICATE_SIMILARITY = 0.6
const isPlaceholderName = (name: string | null) => !name || /^(speaker \d+|them)$/i.test(name.trim())

function mergeNearDuplicates<T>(items: T[], text: (item: T) => string): T[] {
  const kept: T[] = []
  for (const item of items) {
    if (!kept.some((k) => wordSimilarity(text(k), text(item)) >= DUPLICATE_SIMILARITY)) kept.push(item)
  }
  return kept
}

/**
 * Small models often list the same task twice (the request and the "yes, I'll do it" reply). Keep the
 * earliest mention, preferring a real name over a diarization label and filling in a missing due date.
 */
function mergeActionItems(items: ActionItem[]): ActionItem[] {
  const kept: ActionItem[] = []
  for (const item of items) {
    const twin = kept.find((k) => wordSimilarity(k.task, item.task) >= DUPLICATE_SIMILARITY)
    if (!twin) {
      kept.push({ ...item })
      continue
    }
    if (isPlaceholderName(twin.owner) && !isPlaceholderName(item.owner)) twin.owner = item.owner
    twin.due ??= item.due
  }
  return kept
}

function cacheKey(kind: 'map' | 'single', chunk: Chunk, model: string): string {
  // FNV-1a; collisions are harmless here (worst case a stale cache hit for an identical-looking chunk).
  let h = 0x811c9dc5
  const input = `${PROMPT_VERSION}|${model}|${chunk.startMs}|${chunk.text}`
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${kind}:${(h >>> 0).toString(16)}:${input.length}`
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Summarization cancelled')
}

export async function summarizeMeeting(turns: Turn[], llm: LlmClient, options: SummarizeOptions = {}): Promise<MeetingSummary> {
  const { chunkTokens = DEFAULT_CHUNK_TOKENS, overlapTurns = 2, onProgress, signal, mapCache } = options
  const generatedAt = Date.now()

  if (!turns.length) {
    return {
      title: 'Untitled meeting',
      tldr: 'No speech was transcribed for this meeting.',
      keyPoints: [],
      decisions: [],
      actionItems: [],
      openQuestions: [],
      generatedAt,
      model: llm.modelName,
    }
  }

  const chunks = chunkTurns(turns, (t) => llm.countTokens(t), chunkTokens, overlapTurns)
  if (chunks.length === 1) return singlePass(chunks[0], llm, { onProgress, mapCache, generatedAt })

  const verified: { chunk: Chunk; notes: ReturnType<typeof verifyChunkNotes> }[] = []
  onProgress?.({ stage: 'map', done: 0, total: chunks.length })
  for (const chunk of chunks) {
    throwIfAborted(signal)
    const key = cacheKey('map', chunk, llm.modelName)
    let raw = mapCache?.get(key) as ChunkNotes | undefined
    if (!raw) {
      raw = (await llm.generateJson({
        system: MAP_SYSTEM,
        prompt: buildMapPrompt(chunk, chunks.length),
        schema: MAP_SCHEMA,
        maxTokens: 2000,
      })) as ChunkNotes
      mapCache?.set(key, raw)
    }
    verified.push({ chunk, notes: verifyChunkNotes(raw, chunk) })
    onProgress?.({ stage: 'map', done: verified.length, total: chunks.length })
  }

  throwIfAborted(signal)
  const notes = mergeVerified(verified)
  const participants = [...new Set(turns.map((t) => t.label))]
  onProgress?.({ stage: 'reduce', done: 0, total: 1 })
  const reduced = (await llm.generateJson({
    system: MAP_SYSTEM,
    prompt: buildReducePrompt(notes, participants.map((p) => (p === 'You' ? 'You (note-taker)' : p))),
    schema: REDUCE_SCHEMA,
    maxTokens: 2500,
  })) as ReduceOutput
  onProgress?.({ stage: 'reduce', done: 1, total: 1 })

  const { decisions, actionItems } = resolveReduce(reduced, notes)
  return {
    title: reduced.title.trim() || 'Untitled meeting',
    tldr: reduced.tldr.trim(),
    keyPoints: reduced.keyPoints
      .map((k) => ({ topic: k.topic.trim(), points: k.points.map((p) => p.trim()).filter(Boolean) }))
      .filter((k) => k.points.length > 0),
    decisions,
    actionItems,
    openQuestions: reduced.openQuestions.map((q) => q.trim()).filter(Boolean),
    generatedAt,
    model: llm.modelName,
  }
}

/** Markdown export of the notes. Rendered in code so formatting is consistent regardless of model. */
export function renderSummaryMarkdown(summary: MeetingSummary, meta: { startedAt: number; sourceApp: string | null }): string {
  const out: string[] = [`# ${summary.title}`, '', `_${new Date(meta.startedAt).toLocaleString()}${meta.sourceApp ? ` · ${meta.sourceApp}` : ''}_`, '']
  if (summary.tldr) out.push('## TL;DR', '', summary.tldr, '')
  if (summary.keyPoints.length) {
    out.push('## Key points', '')
    for (const k of summary.keyPoints) {
      out.push(`### ${k.topic}`, '', ...k.points.map((p) => `- ${p}`), '')
    }
  }
  if (summary.decisions.length) {
    out.push('## Decisions', '', ...summary.decisions.map((d) => `- ${d.text}${d.ts !== null ? ` (${formatTimestamp(d.ts)})` : ''}`), '')
  }
  if (summary.actionItems.length) {
    out.push(
      '## Action items',
      '',
      ...summary.actionItems.map((a) => {
        const meta = [a.owner, a.due ? `due ${a.due}` : null, a.ts !== null ? formatTimestamp(a.ts) : null].filter(Boolean).join(' · ')
        return `- [${a.done ? 'x' : ' '}] ${a.task}${meta ? ` — ${meta}` : ''}`
      }),
      '',
    )
  }
  if (summary.openQuestions.length) out.push('## Open questions', '', ...summary.openQuestions.map((q) => `- ${q}`), '')
  return out.join('\n').trimEnd() + '\n'
}

async function singlePass(
  chunk: Chunk,
  llm: LlmClient,
  { onProgress, mapCache, generatedAt }: Pick<SummarizeOptions, 'onProgress' | 'mapCache'> & { generatedAt: number },
): Promise<MeetingSummary> {
  onProgress?.({ stage: 'reduce', done: 0, total: 1 })
  const key = cacheKey('single', chunk, llm.modelName)
  let raw = mapCache?.get(key) as SinglePassNotes | undefined
  if (!raw) {
    raw = (await llm.generateJson({ system: MAP_SYSTEM, prompt: buildSinglePassPrompt(chunk), schema: NOTES_SCHEMA, maxTokens: 2500 })) as SinglePassNotes
    mapCache?.set(key, raw)
  }
  onProgress?.({ stage: 'reduce', done: 1, total: 1 })

  const verified = verifyChunkNotes({ topics: [], decisions: raw.decisions, actionItems: raw.actionItems, openQuestions: raw.openQuestions }, chunk)
  return {
    title: raw.title.trim() || 'Untitled meeting',
    tldr: raw.tldr.trim(),
    keyPoints: raw.keyPoints
      .map((k) => ({ topic: k.topic.trim(), points: k.points.map((p) => p.trim()).filter(Boolean) }))
      .filter((k) => k.points.length > 0),
    decisions: mergeNearDuplicates(
      verified.decisions.map((d) => ({ text: d.text, ts: d.ts })),
      (d) => d.text,
    ),
    actionItems: mergeActionItems(verified.actionItems.map((a) => ({ ...a, done: false })).sort((x, y) => x.ts - y.ts)),
    openQuestions: mergeNearDuplicates(verified.openQuestions, (q) => q),
    generatedAt,
    model: llm.modelName,
  }
}
