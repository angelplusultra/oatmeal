/**
 * Echo detection. Without headphones, the mic hears the remote participants coming out of the speakers,
 * so the same words get transcribed twice: once (cleanly) on the system channel and once on the mic.
 * We drop a mic line when a system line overlapping it in time says essentially the same thing.
 */

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Dice coefficient over word multisets: 1 = same words, 0 = nothing in common. */
export function wordSimilarity(a: string, b: string): number {
  const wa = words(a)
  const wb = words(b)
  if (!wa.length || !wb.length) return 0
  const counts = new Map<string, number>()
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1)
  let common = 0
  for (const w of wb) {
    const c = counts.get(w) ?? 0
    if (c > 0) {
      common++
      counts.set(w, c - 1)
    }
  }
  return (2 * common) / (wa.length + wb.length)
}

export interface TimedText {
  startMs: number
  endMs: number
  text: string
}

export function overlapsInTime(a: TimedText, b: TimedText, toleranceMs = 1500): boolean {
  return a.startMs <= b.endMs + toleranceMs && b.startMs <= a.endMs + toleranceMs
}

/** True when `mic` looks like `system` leaking into the microphone. */
export function isEcho(mic: TimedText, system: TimedText, threshold = 0.6): boolean {
  if (!overlapsInTime(mic, system)) return false
  const micWords = words(mic.text)
  if (micWords.length < 3) {
    // Very short lines ("yeah", "okay") are too ambiguous to compare by overlap; require an exact match.
    return micWords.length > 0 && micWords.join(' ') === words(system.text).join(' ')
  }
  return wordSimilarity(mic.text, system.text) >= threshold
}
