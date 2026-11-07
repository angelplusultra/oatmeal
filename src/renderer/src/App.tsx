import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { OatmealEvents } from '@shared/api'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HomeView } from '@/components/home-view'
import { MeetingView } from '@/components/meeting-view'
import { SettingsView } from '@/components/settings-view'
import { Sidebar } from '@/components/sidebar'
import { useEvent, useRecordingState } from '@/hooks/use-oatmeal'

export type View = { kind: 'home' } | { kind: 'meeting'; id: string } | { kind: 'settings' }

export function App() {
  const [view, setView] = useState<View>({ kind: 'home' })
  const recording = useRecordingState()

  const navigate = (target: OatmealEvents['navigate']) => {
    if ('meetingId' in target) setView(target.meetingId ? { kind: 'meeting', id: target.meetingId } : { kind: 'home' })
    else setView({ kind: 'settings' })
  }
  useEvent('navigate', navigate)
  useEffect(() => {
    void window.oatmeal.takePendingNavigation().then((target) => target && navigate(target))
    void window.oatmeal.getRecordingState().then((state) => {
      if (state.kind === 'recording' || state.kind === 'starting') setView({ kind: 'meeting', id: state.meetingId })
    })
  }, [])
  useEvent('recording-state', (state) => {
    if (state.kind === 'starting' || state.kind === 'recording') setView({ kind: 'meeting', id: state.meetingId })
  })
  useEvent('toast', ({ kind, message }) => {
    if (kind === 'error') toast.error(message)
    else if (kind === 'success') toast.success(message)
    else toast(message)
  })

  return (
    <TooltipProvider>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <Sidebar view={view} onNavigate={setView} recording={recording} />
        <main className="flex min-w-0 flex-1 flex-col">
          {view.kind === 'home' && <HomeView onNavigate={setView} recording={recording} />}
          {view.kind === 'meeting' && <MeetingView key={view.id} meetingId={view.id} recording={recording} onNavigate={setView} />}
          {view.kind === 'settings' && <SettingsView />}
        </main>
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
