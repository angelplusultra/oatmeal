export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m`
  return `${s}s`
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function formatDay(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.round(bytes / 1e3)} KB`
}

// Muted, warm hues from the Pantry palette (globals.css). "You" is honey.
const SPEAKER_COLORS = ['text-speaker-1', 'text-speaker-2', 'text-speaker-3', 'text-speaker-4', 'text-speaker-5', 'text-speaker-6']

export function speakerColor(key: string): string {
  if (key === 'me') return 'text-brand-text'
  const m = /^sys:(\d+)$/.exec(key)
  return SPEAKER_COLORS[m ? Number(m[1]) % SPEAKER_COLORS.length : 0]
}
