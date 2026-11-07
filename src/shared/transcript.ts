import type { Segment, SpeakerKey } from './types'

/** Human label for a speaker key, honoring user renames. */
export function speakerLabel(key: SpeakerKey, names: Record<SpeakerKey, string> = {}): string {
  const custom = names[key]?.trim()
  if (custom) return custom
  if (key === 'me') return 'You'
  if (key === 'them') return 'Them'
  const m = /^sys:(\d+)$/.exec(key)
  if (m) return `Speaker ${Number(m[1]) + 1}`
  return key
}

/** `03:07` under an hour, `1:03:07` otherwise. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Parses `m:ss`, `mm:ss` or `h:mm:ss` (optionally bracketed) into milliseconds. */
export function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const m = /(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(value)
  if (!m) return null
  const parts = [m[1], m[2], m[3]].filter((p) => p !== undefined).map(Number)
  const [a, b, c] = parts
  const seconds = parts.length === 3 ? a * 3600 + b * 60 + c : a * 60 + b
  return seconds * 1000
}

const FILLERS = /(^|[\s,])(?:u+m+|u+h+|e+r+m+|h+m+)(?=[\s,.!?]|$)[,.]?/gi

/** Removes standalone filler words (um, uh, erm, hmm). Used only for the LLM's copy of the transcript. */
export function stripFillers(text: string): string {
  return text
    .replace(FILLERS, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/^[,\s]+/, '')
    .trim()
}

export interface Turn {
  speaker: SpeakerKey
  label: string
  startMs: number
  endMs: number
  text: string
}

export interface BuildTurnsOptions {
  /** Merge consecutive lines from the same speaker when the gap between them is below this. */
  mergeGapMs?: number
  /** Stop merging once a turn's text reaches this length, so no single turn dominates a chunk. */
  maxTurnChars?: number
  stripFillers?: boolean
}

/** Turns raw ASR segments into speaker turns for the LLM. Echo lines and empty lines are dropped. */
export function buildTurns(
  segments: readonly Segment[],
  names: Record<SpeakerKey, string> = {},
  options: BuildTurnsOptions = {},
): Turn[] {
  const { mergeGapMs = 2000, maxTurnChars = 1500, stripFillers: strip = true } = options
  const sorted = [...segments].filter((s) => !s.echo).sort((a, b) => a.startMs - b.startMs || a.id - b.id)
  const turns: Turn[] = []
  for (const seg of sorted) {
    const text = strip ? stripFillers(seg.text) : seg.text.trim()
    if (!text) continue
    const last = turns.at(-1)
    if (
      last &&
      last.speaker === seg.speaker &&
      seg.startMs - last.endMs <= mergeGapMs &&
      last.text.length + text.length < maxTurnChars
    ) {
      last.text = `${last.text} ${text}`
      last.endMs = Math.max(last.endMs, seg.endMs)
      continue
    }
    turns.push({ speaker: seg.speaker, label: speakerLabel(seg.speaker, names), startMs: seg.startMs, endMs: seg.endMs, text })
  }
  return turns
}

export function formatTurn(turn: Turn): string {
  return `[${formatTimestamp(turn.startMs)}] ${turn.label}: ${turn.text}`
}

export interface Chunk {
  index: number
  turns: Turn[]
  startMs: number
  endMs: number
  text: string
}

/**
 * Splits turns into chunks of at most `maxTokens` (as measured by `countTokens`), cutting only between
 * turns. Each chunk after the first repeats the last `overlapTurns` turns of the previous one so
 * nothing said across a cut is lost.
 */
export function chunkTurns(
  turns: readonly Turn[],
  countTokens: (text: string) => number,
  maxTokens: number,
  overlapTurns = 2,
): Chunk[] {
  const chunks: Chunk[] = []
  let current: Turn[] = []
  let currentTokens = 0
  let freshInCurrent = 0
  const lineTokens = turns.map((t) => countTokens(formatTurn(t)) + 1)

  const flush = () => {
    if (!current.length) return
    chunks.push({
      index: chunks.length,
      turns: current,
      startMs: current[0].startMs,
      endMs: current.at(-1)!.endMs,
      text: current.map(formatTurn).join('\n'),
    })
  }

  turns.forEach((turn, i) => {
    const cost = lineTokens[i]
    if (current.length && freshInCurrent > 0 && currentTokens + cost > maxTokens) {
      flush()
      const carry = overlapTurns > 0 ? current.slice(-overlapTurns) : []
      current = [...carry]
      currentTokens = carry.reduce((sum, t) => sum + countTokens(formatTurn(t)) + 1, 0)
      freshInCurrent = 0
    }
    current.push(turn)
    currentTokens += cost
    freshInCurrent++
  })
  flush()
  return chunks
}

/** Plain-text transcript, one line per segment. */
export function transcriptToText(segments: readonly Segment[], names: Record<SpeakerKey, string> = {}): string {
  return segments
    .filter((s) => !s.echo && s.text.trim())
    .map((s) => `[${formatTimestamp(s.startMs)}] ${speakerLabel(s.speaker, names)}: ${s.text.trim()}`)
    .join('\n')
}

export function transcriptToMarkdown(
  title: string,
  startedAt: number,
  segments: readonly Segment[],
  names: Record<SpeakerKey, string> = {},
): string {
  const lines = segments
    .filter((s) => !s.echo && s.text.trim())
    .map((s) => `**${speakerLabel(s.speaker, names)}** \`${formatTimestamp(s.startMs)}\`  \n${s.text.trim()}`)
  return `# ${title} — transcript\n\n_${new Date(startedAt).toLocaleString()}_\n\n${lines.join('\n\n')}\n`
}

export function transcriptToJson(segments: readonly Segment[], names: Record<SpeakerKey, string> = {}) {
  return segments
    .filter((s) => !s.echo && s.text.trim())
    .map((s) => ({
      start: s.startMs / 1000,
      end: s.endMs / 1000,
      channel: s.channel,
      speaker: speakerLabel(s.speaker, names),
      speakerKey: s.speaker,
      text: s.text.trim(),
    }))
}
