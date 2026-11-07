import { describe, expect, it } from 'vitest'
import { isEcho, wordSimilarity } from './echo'

describe('wordSimilarity', () => {
  it('is 1 for identical text and 0 for disjoint text', () => {
    expect(wordSimilarity('The plan is ready.', 'the plan is ready')).toBe(1)
    expect(wordSimilarity('apples and pears', 'cars trucks boats')).toBe(0)
  })
})

describe('isEcho', () => {
  const sys = { startMs: 10_000, endMs: 14_000, text: 'We should ship the pricing change next Tuesday after QA signs off.' }

  it('flags a near-duplicate mic line that overlaps in time', () => {
    expect(isEcho({ startMs: 10_300, endMs: 14_200, text: 'we should ship the pricing change next tuesday after qa signs' }, sys)).toBe(true)
  })

  it('ignores the same words said much later', () => {
    expect(isEcho({ startMs: 60_000, endMs: 64_000, text: sys.text }, sys)).toBe(false)
  })

  it('keeps a genuine reply that overlaps in time', () => {
    expect(isEcho({ startMs: 13_000, endMs: 15_000, text: 'Sounds good, I will tell the QA team today.' }, sys)).toBe(false)
  })

  it('requires an exact match for very short lines', () => {
    const shortSys = { startMs: 0, endMs: 1000, text: 'Okay.' }
    expect(isEcho({ startMs: 100, endMs: 900, text: 'okay' }, shortSys)).toBe(true)
    expect(isEcho({ startMs: 100, endMs: 900, text: 'yeah' }, shortSys)).toBe(false)
  })
})
