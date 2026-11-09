/**
 * Deciding when a call has ended, once the meeting app has let go of the microphone.
 *
 * - Left the call: the app stops using the mic *and* stops playing audio. Stop after a short grace.
 * - Muted (some apps release the mic) or the app keeps its speaker open: it is still playing audio. Keep
 *   recording until nobody on the call has spoken for `silenceTimeoutMs`.
 *
 * If the app grabs the mic again, the caller cancels the wait entirely.
 */

/** Absorbs momentary drops, e.g. switching audio devices. */
export const QUIET_GRACE_MS = 2000

export interface CallEndInput {
  now: number
  /** When the meeting app released the microphone. */
  micReleasedAt: number
  /** Whether the meeting app is still playing audio. */
  appPlaying: boolean
  /** When it stopped playing audio, if it has. */
  playingStoppedAt: number | null
  /** Last time we heard anyone on the call (system-audio speech). */
  lastRemoteSpeechAt: number
  /** Whether someone on the call is talking right now. */
  remoteSpeaking: boolean
  silenceTimeoutMs: number
}

export function callEndDecision(input: CallEndInput): 'stop' | 'wait' {
  const { now, micReleasedAt, appPlaying, playingStoppedAt, lastRemoteSpeechAt, remoteSpeaking, silenceTimeoutMs } =
    input
  if (!appPlaying) {
    const quietSince = Math.max(micReleasedAt, playingStoppedAt ?? micReleasedAt)
    return now - quietSince >= QUIET_GRACE_MS ? 'stop' : 'wait'
  }
  if (remoteSpeaking) return 'wait'
  const silentSince = Math.max(micReleasedAt, lastRemoteSpeechAt)
  return now - silentSince >= silenceTimeoutMs ? 'stop' : 'wait'
}
