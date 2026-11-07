import { describe, expect, it } from 'vitest'
import {
  buildTurns,
  chunkTurns,
  formatTimestamp,
  parseTimestamp,
  speakerLabel,
  stripFillers,
  transcriptToText,
  type Turn,
} from './transcript'
import type { Segment } from './types'

let nextId = 1
function seg(speaker: string, startS: number, endS: number, text: string, extra: Partial<Segment> = {}): Segment {
  return {
    id: nextId++,
    meetingId: 'm',
    lineId: `x${nextId}`,
    channel: speaker === 'me' ? 'mic' : 'system',
    speaker,
    startMs: startS * 1000,
    endMs: endS * 1000,
    text,
    echo: false,
    ...extra,
  }
}

describe('timestamps', () => {
  it('formats under and over an hour', () => {
    expect(formatTimestamp(0)).toBe('00:00')
    expect(formatTimestamp(210_000)).toBe('03:30')
    expect(formatTimestamp(3_723_000)).toBe('1:02:03')
  })

  it('parses loosely', () => {
    expect(parseTimestamp('3:30')).toBe(210_000)
    expect(parseTimestamp('[03:30]')).toBe(210_000)
    expect(parseTimestamp('1:02:03')).toBe(3_723_000)
    expect(parseTimestamp('at 12:05 roughly')).toBe(725_000)
    expect(parseTimestamp('soon')).toBeNull()
    expect(parseTimestamp(null)).toBeNull()
  })
})

describe('speakerLabel', () => {
  it('uses defaults and renames', () => {
    expect(speakerLabel('me')).toBe('You')
    expect(speakerLabel('them')).toBe('Them')
    expect(speakerLabel('sys:0')).toBe('Speaker 1')
    expect(speakerLabel('sys:2', { 'sys:2': 'Priya' })).toBe('Priya')
    expect(speakerLabel('sys:2', { 'sys:2': '  ' })).toBe('Speaker 3')
  })
})

describe('stripFillers', () => {
  it('removes standalone fillers but keeps real words', () => {
    expect(stripFillers('Um, so uh I think we should, um, ship it.')).toBe('so I think we should, ship it.')
    expect(stripFillers('Hmm. The umbrella and the hummus.')).toBe('The umbrella and the hummus.')
    expect(stripFillers('Uh-huh, sounds good')).toBe('Uh-huh, sounds good')
  })
})

describe('buildTurns', () => {
  it('merges consecutive same-speaker lines, drops echo and empty lines, and sorts', () => {
    const turns = buildTurns(
      [
        seg('sys:0', 5, 7, 'Second part.'),
        seg('sys:0', 2, 4.5, 'First part.'),
        seg('me', 8, 9, 'Got it.'),
        seg('me', 8.5, 9.5, 'Second part.', { echo: true }),
        seg('me', 20, 21, 'um'),
        seg('sys:0', 30, 31, 'Much later.'),
      ],
      { 'sys:0': 'Priya' },
    )
    expect(turns.map((t) => [t.label, t.text])).toEqual([
      ['Priya', 'First part. Second part.'],
      ['You', 'Got it.'],
      ['Priya', 'Much later.'],
    ])
    expect(turns[0].startMs).toBe(2000)
    expect(turns[0].endMs).toBe(7000)
  })

  it('does not merge across long gaps or past the size cap', () => {
    const turns = buildTurns([seg('me', 0, 1, 'a'), seg('me', 10, 11, 'b')])
    expect(turns).toHaveLength(2)
    const long = buildTurns([seg('me', 0, 1, 'x'.repeat(1000)), seg('me', 1, 2, 'y'.repeat(1000))])
    expect(long).toHaveLength(2)
  })
})

describe('chunkTurns', () => {
  const countWords = (t: string) => t.split(/\s+/).length
  const turns: Turn[] = Array.from({ length: 10 }, (_, i) => ({
    speaker: 'me',
    label: 'You',
    startMs: i * 10_000,
    endMs: i * 10_000 + 5000,
    text: 'one two three four five six seven eight',
  }))

  it('keeps everything in one chunk when it fits', () => {
    const chunks = chunkTurns(turns, countWords, 10_000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].turns).toHaveLength(10)
    expect(chunks[0].startMs).toBe(0)
    expect(chunks[0].endMs).toBe(95_000)
  })

  it('splits with overlap and covers every turn', () => {
    // Each formatted line is "[00:00] You: " + 8 words = 10 words, +1 => 11 tokens. Budget 35 => 3 turns per chunk.
    const chunks = chunkTurns(turns, countWords, 35, 1)
    expect(chunks.length).toBeGreaterThan(1)
    const covered = new Set(chunks.flatMap((c) => c.turns.map((t) => t.startMs)))
    expect(covered.size).toBe(10)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].turns[0]).toBe(chunks[i - 1].turns.at(-1))
    }
    for (const c of chunks) expect(c.text.split('\n')).toHaveLength(c.turns.length)
  })

  it('always makes progress even if one turn exceeds the budget', () => {
    const chunks = chunkTurns(turns.slice(0, 3), countWords, 5, 2)
    expect(chunks).toHaveLength(3)
  })
})

describe('transcriptToText', () => {
  it('skips echo lines and uses speaker names', () => {
    const text = transcriptToText([seg('me', 1, 2, 'Hi.'), seg('me', 2, 3, 'dup', { echo: true }), seg('sys:1', 4, 5, 'Hello!')], {
      'sys:1': 'Sam',
    })
    expect(text).toBe('[00:01] You: Hi.\n[00:04] Sam: Hello!')
  })
})
