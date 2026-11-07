import { useCallback, useEffect, useRef, useState } from 'react'
import type { OatmealEvents } from '@shared/api'
import type {
  Meeting,
  MeetingListItem,
  ModelStatus,
  PermissionStatus,
  RecordingState,
  Segment,
  Settings,
  SummaryProgress,
} from '@shared/types'

const api = () => window.oatmeal

export function useEvent<K extends keyof OatmealEvents>(event: K, listener: (payload: OatmealEvents[K]) => void) {
  const ref = useRef(listener)
  ref.current = listener
  useEffect(() => api().on(event, (payload) => ref.current(payload)), [event])
}

export function useMeetings(query: string) {
  const [meetings, setMeetings] = useState<MeetingListItem[]>([])
  const refresh = useCallback(() => void api().listMeetings(query).then(setMeetings), [query])
  useEffect(refresh, [refresh])
  useEvent('meetings-changed', refresh)
  return meetings
}

export function useMeeting(id: string | null) {
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])

  useEffect(() => {
    setMeeting(null)
    setSegments([])
    if (!id) return
    let cancelled = false
    void Promise.all([api().getMeeting(id), api().getSegments(id)]).then(([m, s]) => {
      if (cancelled) return
      setMeeting(m)
      setSegments(s)
    })
    return () => {
      cancelled = true
    }
  }, [id])

  useEvent('meeting-updated', ({ meetingId }) => {
    if (meetingId === id) void api().getMeeting(id).then(setMeeting)
  })

  useEvent('segment', ({ meetingId, segment }) => {
    if (meetingId !== id) return
    setSegments((current) => {
      const index = current.findIndex((s) => s.id === segment.id)
      if (index >= 0) {
        const next = current.slice()
        next[index] = segment
        return next
      }
      const next = [...current, segment]
      // Lines from the two channels can complete out of order.
      if (current.length && current[current.length - 1].startMs > segment.startMs) next.sort((a, b) => a.startMs - b.startMs)
      return next
    })
  })

  return { meeting, segments }
}

export function useRecordingState() {
  const [state, setState] = useState<RecordingState>({ kind: 'idle' })
  useEffect(() => void api().getRecordingState().then(setState), [])
  useEvent('recording-state', setState)
  return state
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => void api().getSettings().then(setSettings), [])
  const update = useCallback(async (patch: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s))
    setSettings(await api().updateSettings(patch))
  }, [])
  return { settings, update }
}

export function useModelStatus() {
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const refresh = useCallback(() => void api().getModelStatus().then(setStatus), [])
  useEffect(refresh, [refresh])
  useEvent('model-status', setStatus)
  return { status, refresh }
}

export function usePermissions() {
  const [permissions, setPermissions] = useState<PermissionStatus | null>(null)
  const refresh = useCallback(() => void api().getPermissions().then(setPermissions), [])
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])
  return { permissions, refresh, setPermissions }
}

export function useSummaryProgress(meetingId: string | null) {
  const [progress, setProgress] = useState<SummaryProgress | null>(null)
  useEffect(() => setProgress(null), [meetingId])
  useEvent('summary-progress', (p) => {
    if (p.meetingId === meetingId) setProgress(p)
  })
  return progress
}

/** Re-renders every second while `active`, for live clocks. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}
