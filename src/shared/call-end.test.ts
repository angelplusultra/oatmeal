import { describe, expect, it } from 'vitest'
import { callEndDecision, QUIET_GRACE_MS, type CallEndInput } from './call-end'

const base: CallEndInput = {
  now: 100_000,
  micReleasedAt: 100_000,
  appPlaying: false,
  playingStoppedAt: 100_000,
  lastRemoteSpeechAt: 99_000,
  remoteSpeaking: false,
  silenceTimeoutMs: 30_000,
}

describe('callEndDecision', () => {
  it('stops shortly after the app releases the mic and goes quiet (left the call)', () => {
    expect(callEndDecision({ ...base, now: 100_000 + QUIET_GRACE_MS - 1 })).toBe('wait')
    expect(callEndDecision({ ...base, now: 100_000 + QUIET_GRACE_MS })).toBe('stop')
  })

  it('waits for the grace period from whichever happened last: mic release or audio stopping', () => {
    const input = { ...base, playingStoppedAt: 103_000, now: 104_000 }
    expect(callEndDecision(input)).toBe('wait')
    expect(callEndDecision({ ...input, now: 105_000 })).toBe('stop')
  })

  it('keeps recording while the app still plays audio and people are talking (muted)', () => {
    const muted = { ...base, appPlaying: true, playingStoppedAt: null, now: 500_000 }
    expect(callEndDecision({ ...muted, remoteSpeaking: true })).toBe('wait')
    expect(callEndDecision({ ...muted, lastRemoteSpeechAt: 490_000 })).toBe('wait')
  })

  it('stops a "playing" app once nobody has spoken for the silence timeout', () => {
    const idle = { ...base, appPlaying: true, playingStoppedAt: null, lastRemoteSpeechAt: 95_000 }
    expect(callEndDecision({ ...idle, now: 129_999 })).toBe('wait') // timer starts at mic release (100 s), not last speech
    expect(callEndDecision({ ...idle, now: 130_000 })).toBe('stop')
  })
})
