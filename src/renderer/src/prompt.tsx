import { AlertCircleIcon, FileTextIcon, MicIcon } from 'lucide-react'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { PanelAction, PanelState } from '@shared/types'
import { Button } from '@/components/ui/button'
import './globals.css'
import { followSystemTheme } from './lib/theme'

followSystemTheme()

const respond = (action: PanelAction) => void window.oatmeal.respondToPanel(action)

function Shell({ icon, title, body, actions }: { icon: React.ReactNode; title: string; body: React.ReactNode; actions: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col justify-between gap-3 bg-background p-4 text-foreground select-none [-webkit-app-region:drag]">
      <div className="flex min-h-0 gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">{icon}</div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{title}</p>
          <div className="line-clamp-2 text-sm text-muted-foreground">{body}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">{actions}</div>
    </div>
  )
}

function CallPanel({ name }: { name: string }) {
  return (
    <Shell
      icon={<MicIcon className="size-4" />}
      title={`${name} is using your microphone`}
      body="Transcribe this call? Oatmeal will write notes when it ends."
      actions={
        <>
          <Button size="sm" variant="link" className="mr-auto px-0 text-muted-foreground" onClick={() => respond('never')}>
            Never for {name}
          </Button>
          <Button size="sm" variant="outline" onClick={() => respond('dismiss')}>
            Not now
          </Button>
          <Button size="sm" onClick={() => respond('start')}>
            Transcribe
          </Button>
        </>
      }
    />
  )
}

function NotesPanel({ panel }: { panel: Extract<PanelState, { kind: 'notes' }> }) {
  const failed = panel.outcome === 'failed'
  const title = panel.outcome === 'ready' ? 'Your notes are ready' : failed ? "Couldn't write notes" : 'Call ended'
  return (
    <Shell
      icon={failed ? <AlertCircleIcon className="size-4" /> : <FileTextIcon className="size-4" />}
      title={title}
      body={
        <>
          <span className="font-medium text-foreground">{panel.title}</span>
          {panel.preview ? ` — ${panel.preview}` : ''}
        </>
      }
      actions={
        <>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => respond('dismiss')}>
            Dismiss
          </Button>
          <Button size="sm" onClick={() => respond('view')}>
            {panel.outcome === 'ready' ? 'View notes' : 'Open'}
          </Button>
        </>
      }
    />
  )
}

function Panel() {
  const [panel, setPanel] = useState<PanelState | null>(null)
  useEffect(() => {
    void window.oatmeal.getPanel().then(setPanel)
    return window.oatmeal.on('panel', setPanel)
  }, [])
  if (!panel) return null
  return panel.kind === 'call' ? <CallPanel name={panel.app.name} /> : <NotesPanel panel={panel} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
)
