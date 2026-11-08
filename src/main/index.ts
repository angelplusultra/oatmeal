import { app, Menu, Notification } from 'electron'
import os from 'node:os'
import path from 'node:path'
import type { OatmealEvents } from '@shared/api'
import { defaultSettings } from '@shared/models'
import type { AsrEvents, AsrRequests, LlmEvents, LlmRequests } from '@shared/protocol'
import type { ModelKind, Settings } from '@shared/types'
import { Store } from './db'
import { MeetingDetector } from './detector'
import { applyUserDataOverride, createScreenshotter, fakeAudioFromEnv } from './dev'
import { registerIpc } from './ipc'
import { Orchestrator } from './orchestrator'
import { getPaths } from './paths'
import { AppTray } from './tray'
import { Updater } from './updater'
import { WorkerClient } from './worker-client'
import { WindowManager } from './windows'

const outDir = import.meta.dirname

app.setName('Oatmeal')
applyUserDataOverride()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(main)
}

async function main() {
  const paths = getPaths()
  // Linux: no File/Edit/View menu bar. Text-field shortcuts (copy, paste, undo) work without it.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  // Packaged builds get the icon from the bundle; in dev, show it in the Dock too.
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(path.join(app.getAppPath(), 'build', 'icon.png'))
  const store = new Store(paths.db)
  const defaults = defaultSettings({ cpuCount: os.cpus().length, totalMemGB: os.totalmem() / 2 ** 30 })
  let settings = store.getSettings(defaults)

  const windows = new WindowManager(outDir)
  let onBroadcast: <K extends keyof OatmealEvents>(event: K, payload: OatmealEvents[K]) => void = () => {}
  const broadcast = <K extends keyof OatmealEvents>(event: K, payload: OatmealEvents[K]) => {
    windows.broadcast(event, payload)
    onBroadcast(event, payload)
  }

  const asr = new WorkerClient<AsrRequests, AsrEvents>(path.join(outDir, 'asr-worker.js'), 'Oatmeal Speech', async (client) => {
    await client.send('init', { libDir: paths.moonshineLib, modelsDir: paths.models })
  })
  const llm = new WorkerClient<LlmRequests, LlmEvents>(path.join(outDir, 'llm-worker.js'), 'Oatmeal Notes')
  const ownPids = () => app.getAppMetrics().map((m) => m.pid)
  const detector = new MeetingDetector(paths.helper, () => new Set(ownPids()))

  // Set up below, once the orchestrator exists (it reports whether a restart would cut off a recording).
  let updater: Updater | null = null
  const updateSettings = (patch: Partial<Settings>): Settings => {
    settings = { ...settings, ...patch }
    store.saveSettings(settings)
    if ('detectionEnabled' in patch) {
      if (settings.detectionEnabled) detector.start()
      else detector.stop()
    }
    if ('autoUpdate' in patch) updater?.setEnabled(settings.autoUpdate)
    return settings
  }

  const screenshot = createScreenshotter(() => windows.main)
  const screenshotPanel = createScreenshotter(() => windows.panelWindow, 'panel')
  const orchestrator = new Orchestrator({
    store,
    paths,
    asr,
    llm,
    detector,
    getSettings: () => settings,
    updateSettings,
    broadcast,
    ownPids,
    fakeAudio: fakeAudioFromEnv(),
    llmModelOverride: process.env.OATMEAL_LLM_MODEL_PATH || undefined,
    ui: {
      showPanel: () => windows.showPanel(),
      hidePanel: () => windows.hidePanel(),
      showMeeting: (meetingId) => windows.navigate({ meetingId }),
      showSettings: () => windows.navigate({ view: 'settings' }),
      notify: (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
      },
      isMainFocused: () => windows.mainFocused,
    },
  })
  orchestrator.recoverUnfinished()
  windows.onMainFocus = () => orchestrator.onMainWindowFocused()

  const activeUpdater = new Updater({
    onChange: (state) => broadcast('update-state', state),
    busyReason: () => (orchestrator.getState().kind === 'idle' ? null : 'Stop the recording before restarting to update'),
  })
  updater = activeUpdater

  registerIpc({ store, paths, orchestrator, windows, broadcast, getSettings: () => settings, updateSettings, updater: activeUpdater })

  const tray = new AppTray(paths.trayIcons, {
    start: () => void orchestrator.start(null),
    stop: () => void orchestrator.stop('user'),
    open: () => windows.showMain(),
    installUpdate: () => {
      try {
        activeUpdater.install()
      } catch (error) {
        broadcast('toast', { kind: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // Keep the tray in sync, and drive the optional screenshot hooks (see dev.ts).
  let stoppedAt = 0
  onBroadcast = (event, payload) => {
    if (event === 'toast' && process.env.OATMEAL_SCREENSHOT_DIR) console.log(`[dev] toast: ${JSON.stringify(payload)}`)
    if (event === 'update-state') {
      const { status } = payload as OatmealEvents['update-state']
      tray.setUpdateReady(status.kind === 'ready' ? status.version : null)
    }
    if (event === 'recording-state') {
      const state = payload as OatmealEvents['recording-state']
      tray.update(state)
      if (state.kind === 'stopping') stoppedAt = Date.now()
      if (state.kind === 'recording') setTimeout(() => void screenshot('recording'), 12_000)
      if (state.kind === 'recording' && process.env.OATMEAL_SCREENSHOT_DIR) {
        setTimeout(() => console.log(`[dev] while recording: main window ${describeWindow(windows)}`), 3000)
      }
    }
    if (event === 'panel' && payload) setTimeout(() => void screenshotPanel((payload as OatmealEvents['panel'])!.kind), 1500)
    if (event === 'panel' && (payload as OatmealEvents['panel'])?.kind === 'notes' && process.env.OATMEAL_DEMO_VIEW) {
      // Click "View notes" on the panel.
      setTimeout(() => void orchestrator.respondToPanel('view'), 2000)
      setTimeout(async () => {
        console.log(`[dev] after "View notes": main window ${describeWindow(windows)}`)
        await screenshot('viewed')
      }, 4000)
    }
    if (event === 'meeting-updated') {
      const meeting = store.getMeeting((payload as OatmealEvents['meeting-updated']).meetingId)
      if (meeting?.status === 'done' || meeting?.status === 'failed') {
        setTimeout(async () => {
          console.log(`[dev] notes ${meeting.status} ${Date.now() - stoppedAt} ms after the call ended: main window ${describeWindow(windows)}`)
          await screenshot(`notes-${meeting.status}`)
          if (process.env.OATMEAL_EXIT_AFTER_NOTES) setTimeout(() => app.quit(), process.env.OATMEAL_DEMO_VIEW ? 6000 : 2500)
        }, 0)
      }
    }
  }

  if (!process.env.OATMEAL_START_HIDDEN) windows.showMain()
  if (settings.detectionEnabled) detector.start()
  activeUpdater.setEnabled(settings.autoUpdate)
  setTimeout(() => void screenshot('home'), 2000)
  if (process.env.OATMEAL_START_VIEW === 'settings') {
    windows.navigate({ view: 'settings' })
    setTimeout(() => void screenshot('settings'), 2500)
  }
  void runDevSetup(orchestrator)

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void orchestrator
      .shutdown()
      .catch((error) => console.error('shutdown failed', error))
      .finally(() => {
        activeUpdater.stop()
        activeUpdater.installOnExit()
        tray.destroy()
        store.close()
        app.exit(0)
      })
  })
  const launchedHiddenAt = process.env.OATMEAL_START_HIDDEN ? Date.now() : 0
  app.on('activate', () => {
    // Dock click: open the window. But never as a side effect of answering the call prompt, so accepting
    // "Transcribe" can't pop Oatmeal over the call. (And in dev, not as a side effect of launching hidden.)
    if (orchestrator.recentlyPrompted() || Date.now() - launchedHiddenAt < 5000) return
    windows.showMain()
  })
  app.on('second-instance', () => {
    // Installing an AppImage update briefly runs the new copy, which hands off to us. Don't pop up for it.
    if (!activeUpdater.installing) windows.showMain()
  })
}

function describeWindow(windows: WindowManager): string {
  const win = windows.main
  if (!win || win.isDestroyed()) return 'not open'
  return `${win.isVisible() ? 'visible' : 'hidden'}, ${win.isFocused() ? 'focused' : 'not focused'}`
}

/** OATMEAL_SETUP=asr,llm downloads models at launch; OATMEAL_AUTOSTART then starts a recording. */
async function runDevSetup(orchestrator: Orchestrator) {
  for (const kind of (process.env.OATMEAL_SETUP ?? '').split(',').filter(Boolean)) {
    console.log(`[dev] downloading ${kind} model`)
    await orchestrator.downloadModel(kind as ModelKind)
    const status = await orchestrator.modelStatus()
    console.log(`[dev] ${kind} model:`, JSON.stringify(status.download))
  }
  if (process.env.OATMEAL_DEMO_PROMPT) {
    // Simulates Zoom grabbing the mic, to exercise the prompt window without a real call.
    await new Promise((r) => setTimeout(r, 2500))
    orchestrator.handleAppStarted({ pid: -1, bundleId: 'us.zoom.xos', name: 'Zoom', browser: false })
    if (process.env.OATMEAL_DEMO_PROMPT === 'accept') {
      await new Promise((r) => setTimeout(r, 1500))
      await orchestrator.respondToPanel('start')
    }
  }
  if (!process.env.OATMEAL_AUTOSTART) return
  await new Promise((r) => setTimeout(r, 2500))
  await orchestrator.start(fakeAudioFromEnv() ? 'Test' : null)
}

// Oatmeal lives in the menu bar; closing the window doesn't quit.
app.on('window-all-closed', () => {})
