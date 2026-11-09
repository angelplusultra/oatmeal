import { PanelLeftIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { OatmealEvents } from '@shared/api'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HomeView } from '@/components/home-view'
import { Onboarding } from '@/components/onboarding'
import { MeetingView } from '@/components/meeting-view'
import { SettingsView } from '@/components/settings-view'
import { Sidebar } from '@/components/sidebar'
import { useEvent, useRecordingState, useSettings } from '@/hooks/use-oatmeal'
import { cn } from '@/lib/utils'

export type View = { kind: 'home' } | { kind: 'meeting'; id: string } | { kind: 'settings' }

export function App() {
  const [view, setView] = useState<View>({ kind: 'home' })
  const recording = useRecordingState()
  const { settings, update } = useSettings()
  /** Narrow windows (below md) hide the sidebar; this shows it over the content. */
  const [navOpen, setNavOpen] = useState(false)
  const go = (v: View) => {
    setView(v)
    setNavOpen(false)
  }

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

  if (!settings || !settings.onboarded) {
    return (
      <TooltipProvider>
        <div className="h-screen bg-background text-foreground">
          {settings && (
            <Onboarding
              onDone={() => {
                setView({ kind: 'home' })
                void update({ onboarded: true })
              }}
            />
          )}
        </div>
        <Toaster position="bottom-right" />
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      <div className="relative flex h-screen overflow-hidden bg-background text-foreground">
        <Sidebar
          view={view}
          onNavigate={go}
          recording={recording}
          className={cn('max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:shadow-xl', !navOpen && 'max-md:hidden')}
        />
        {navOpen && <div className="absolute inset-0 z-20 bg-black/40 md:hidden" onClick={() => setNavOpen(false)} />}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center border-b px-2 md:hidden">
            <Button variant="ghost" size="icon-sm" aria-label="Show meetings" onClick={() => setNavOpen(true)}>
              <PanelLeftIcon />
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            {view.kind === 'home' && <HomeView onNavigate={go} recording={recording} />}
            {view.kind === 'meeting' && <MeetingView key={view.id} meetingId={view.id} recording={recording} onNavigate={go} />}
            {view.kind === 'settings' && <SettingsView onRunSetup={() => void update({ onboarded: false })} />}
          </div>
        </main>
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
