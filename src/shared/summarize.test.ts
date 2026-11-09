import { describe, expect, it } from 'vitest'
import {
  type JsonSchema,
  type LlmClient,
  MAP_SCHEMA,
  NOTES_SCHEMA,
  REDUCE_SCHEMA,
  renderSummaryMarkdown,
  summarizeMeeting,
  verifyChunkNotes,
} from './summarize'
import type { Chunk, Turn } from './transcript'

const turns: Turn[] = [
  { speaker: 'me', label: 'You', startMs: 0, endMs: 5000, text: 'Let us talk about the pricing change.' },
  {
    speaker: 'sys:0',
    label: 'Priya',
    startMs: 210_000,
    endMs: 215_000,
    text: 'Decision: we grandfather existing customers for twelve months.',
  },
  {
    speaker: 'sys:1',
    label: 'Speaker 2',
    startMs: 490_000,
    endMs: 495_000,
    text: 'Priya, can you draft the Stripe migration plan by next Friday?',
  },
  { speaker: 'sys:0', label: 'Priya', startMs: 496_000, endMs: 499_000, text: 'Yes, I will.' },
]

function chunkOf(ts: Turn[]): Chunk {
  return {
    index: 0,
    turns: ts,
    startMs: ts[0].startMs,
    endMs: ts.at(-1)!.endMs,
    text: ts.map((t) => t.text).join('\n'),
  }
}

/** A scripted LLM that records which schema each call used. */
function fakeLlm(
  respond: (schema: JsonSchema, prompt: string) => unknown,
  tokensPerChar = 0.25,
): LlmClient & { calls: JsonSchema[] } {
  const calls: JsonSchema[] = []
  return {
    modelName: 'fake',
    calls,
    countTokens: (t) => Math.ceil(t.length * tokensPerChar),
    async generateJson({ prompt, schema }) {
      calls.push(schema)
      return respond(schema, prompt)
    },
  }
}

const singlePassNotes = {
  title: 'Pricing sync',
  tldr: 'Agreed to grandfather customers.',
  keyPoints: [
    { topic: 'Pricing', points: ['Grandfathering for 12 months'] },
    { topic: 'Empty', points: [] },
  ],
  decisions: [
    { text: 'Grandfather existing customers for 12 months', ts: '03:30' },
    { text: 'Invented decision', ts: '45:00' },
  ],
  actionItems: [
    { task: 'Draft the Stripe migration plan by next Friday', owner: 'Speaker 2', due: null, ts: '08:10' },
    { task: 'Draft the Stripe migration plan', owner: 'Priya', due: 'next Friday', ts: '08:16' },
    { task: 'Book offsite', owner: 'Bob', due: 'March 3rd', ts: '08:12' },
  ],
  openQuestions: ['Is SSO ours?', 'Is SSO ours?'],
}

describe('verifyChunkNotes', () => {
  it('drops items with timestamps outside the chunk and owners that never appear', () => {
    const v = verifyChunkNotes(
      {
        topics: [{ title: 'Pricing', points: ['Grandfathering'] }],
        decisions: [
          { text: 'Grandfather existing customers for 12 months', ts: '3:30' },
          { text: 'Invented decision', ts: '45:00' },
        ],
        actionItems: [
          { task: 'Draft Stripe migration plan', owner: 'Priya', due: 'next Friday', ts: '08:10' },
          { task: 'Book offsite', owner: 'Bob', due: 'March 3rd', ts: '08:12' },
          { task: 'Unparseable', owner: null, due: null, ts: 'later' },
          { task: 'Note-taker task', owner: 'me', due: null, ts: '00:01' },
        ],
        openQuestions: [' Is SSO ours? ', ''],
      },
      chunkOf(turns),
    )
    expect(v.decisions.map((d) => d.text)).toEqual(['Grandfather existing customers for 12 months'])
    expect(v.actionItems.map((a) => [a.task, a.owner, a.due])).toEqual([
      ['Draft Stripe migration plan', 'Priya', 'next Friday'],
      ['Book offsite', null, null],
      ['Note-taker task', 'You', null],
    ])
    expect(v.openQuestions).toEqual(['Is SSO ours?'])
  })
})

describe('summarizeMeeting, short meeting (single pass)', () => {
  it('writes the notes in one call, then verifies and de-duplicates them in code', async () => {
    const llm = fakeLlm(() => singlePassNotes)
    const progress: string[] = []
    const summary = await summarizeMeeting(turns, llm, {
      onProgress: (p) => progress.push(`${p.stage}:${p.done}/${p.total}`),
    })

    expect(llm.calls).toEqual([NOTES_SCHEMA])
    expect(summary.title).toBe('Pricing sync')
    expect(summary.keyPoints).toEqual([{ topic: 'Pricing', points: ['Grandfathering for 12 months'] }])
    expect(summary.decisions).toEqual([{ text: 'Grandfather existing customers for 12 months', ts: 210_000 }])
    // The request and its acknowledgement merge into one item, keeping the real owner and the due date;
    // an owner who never appears in the transcript is removed.
    expect(summary.actionItems.map((a) => [a.task, a.owner, a.due, a.ts])).toEqual([
      ['Draft the Stripe migration plan by next Friday', 'Priya', 'next Friday', 490_000],
      ['Book offsite', null, null, 492_000],
    ])
    expect(summary.openQuestions).toEqual(['Is SSO ours?'])
    expect(progress).toEqual(['reduce:0/1', 'reduce:1/1'])
  })

  it('reuses a cached result', async () => {
    const cache = new Map<string, unknown>()
    await summarizeMeeting(
      turns,
      fakeLlm(() => singlePassNotes),
      { mapCache: cache },
    )
    const second = fakeLlm(() => singlePassNotes)
    await summarizeMeeting(turns, second, { mapCache: cache })
    expect(second.calls).toHaveLength(0)
  })

  it('handles an empty transcript without calling the model', async () => {
    const llm = fakeLlm(() => {
      throw new Error('should not be called')
    })
    const summary = await summarizeMeeting([], llm)
    expect(summary.tldr).toMatch(/No speech/)
    expect(llm.calls).toHaveLength(0)
  })
})

describe('summarizeMeeting, long meeting (map → reduce)', () => {
  // Each turn costs 100 "tokens" and chunks hold 150, so every turn becomes its own chunk.
  const options = { chunkTokens: 150, overlapTurns: 0 }

  function longMeetingLlm(reduce: (prompt: string) => unknown) {
    const llm = fakeLlm((schema, prompt) => {
      if (schema === REDUCE_SCHEMA) return reduce(prompt)
      expect(schema).toBe(MAP_SCHEMA)
      // Like a real model, only report what is in this chunk.
      return {
        topics: [{ title: 'Pricing', points: ['Existing customers keep old prices for 12 months'] }],
        decisions: prompt.includes('twelve months')
          ? [{ text: 'Grandfather existing customers for 12 months', ts: '03:30' }]
          : [],
        actionItems: prompt.includes('Stripe')
          ? [{ task: 'Draft the Stripe migration plan', owner: 'Priya', due: 'next Friday', ts: '08:10' }]
          : prompt.includes('pricing change')
            ? [{ task: 'Follow up with finance', owner: 'You', due: null, ts: '00:00' }]
            : [],
        openQuestions: [],
      }
    })
    llm.countTokens = () => 100
    return llm
  }

  it('extracts per chunk, then resolves the combined notes back to verified items', async () => {
    const llm = longMeetingLlm((prompt) => {
      expect(prompt).toContain('D1 [03:30] Grandfather existing customers')
      expect(prompt).toContain('A2 [08:10] Priya: Draft the Stripe migration plan (due: next Friday)')
      expect(prompt).toContain('PARTICIPANTS: You (note-taker), Priya, Speaker 2')
      return {
        title: 'Pricing and billing sync',
        tldr: 'Agreed to grandfather customers.',
        keyPoints: [{ topic: 'Pricing', points: ['Grandfathering for 12 months'] }],
        decisions: [
          { text: 'Grandfather existing customers for 12 months', ids: ['D1'] },
          { text: 'Hallucinated decision', ids: ['D9'] },
        ],
        actionItems: [{ task: 'Draft Stripe migration plan', owner: 'Bob', due: null, ids: ['a2'] }],
        openQuestions: [],
      }
    })
    const progress: string[] = []
    const summary = await summarizeMeeting(turns, llm, {
      ...options,
      onProgress: (p) => progress.push(`${p.stage}:${p.done}/${p.total}`),
    })

    expect(llm.calls.filter((s) => s === MAP_SCHEMA)).toHaveLength(4)
    expect(summary.decisions).toEqual([{ text: 'Grandfather existing customers for 12 months', ts: 210_000 }])
    // "Bob" is not supported by the source note, so the verified owner wins; the due date is carried over.
    expect(summary.actionItems[1]).toEqual({
      task: 'Draft Stripe migration plan',
      owner: 'Priya',
      due: 'next Friday',
      ts: 490_000,
      done: false,
    })
    // A verified item the reduce step forgot is kept rather than lost.
    expect(summary.actionItems[0].task).toBe('Follow up with finance')
    expect(progress).toEqual(['map:0/4', 'map:1/4', 'map:2/4', 'map:3/4', 'map:4/4', 'reduce:0/1', 'reduce:1/1'])
  })

  it('merges a request and its acknowledgement listed separately by the reduce step', async () => {
    const llm = longMeetingLlm(() => ({
      title: 't',
      tldr: '',
      keyPoints: [],
      decisions: [],
      actionItems: [
        {
          task: 'Own the migration plan and have a first draft by next Friday.',
          owner: 'Speaker 2',
          due: null,
          ids: ['A2'],
        },
        {
          task: 'Have the migration plan draft ready by next Friday.',
          owner: 'Priya',
          due: 'next Friday',
          ids: ['A2'],
        },
        { task: 'Follow up with finance', owner: 'You', due: null, ids: ['A1'] },
      ],
      openQuestions: [],
    }))
    const summary = await summarizeMeeting(turns, llm, options)
    expect(summary.actionItems.map((a) => [a.task, a.owner, a.due])).toEqual([
      ['Follow up with finance', 'You', null],
      ['Own the migration plan and have a first draft by next Friday.', 'Priya', 'next Friday'],
    ])
  })
})

describe('renderSummaryMarkdown', () => {
  it('renders sections and skips empty ones', () => {
    const md = renderSummaryMarkdown(
      {
        title: 'Sync',
        tldr: 'Short.',
        keyPoints: [{ topic: 'Pricing', points: ['A', 'B'] }],
        decisions: [],
        actionItems: [{ task: 'Do it', owner: 'Priya', due: 'Friday', ts: 490_000, done: true }],
        openQuestions: [],
        generatedAt: 0,
        model: 'fake',
      },
      { startedAt: 0, sourceApp: 'Zoom' },
    )
    expect(md).toContain('# Sync')
    expect(md).toContain('### Pricing\n\n- A\n- B')
    expect(md).toContain('- [x] Do it — Priya · due Friday · 08:10')
    expect(md).not.toContain('## Decisions')
  })
})
