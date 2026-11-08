import { app, BrowserWindow, nativeTheme, screen } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { OatmealEvents } from '@shared/api'
import { eventChannel } from '@shared/api'

export class WindowManager {
  main: BrowserWindow | null = null
  private panel: BrowserWindow | null = null
  /** Called when the user focuses the main window. */
  onMainFocus: (() => void) | null = null
  private pendingNavigation: OatmealEvents['navigate'] | null = null

  constructor(private readonly outDir: string) {}

  private background() {
    return nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff'
  }

  private webPreferences(): Electron.WebPreferences {
    return {
      preload: path.join(this.outDir, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    }
  }

  private load(win: BrowserWindow, page: 'index' | 'prompt') {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl) void win.loadURL(`${devUrl}/${page}.html`)
    else void win.loadFile(path.join(this.outDir, `../renderer/${page}.html`))
  }

  showMain(): BrowserWindow {
    if (this.main && !this.main.isDestroyed()) {
      if (this.main.isMinimized()) this.main.restore()
      this.main.show()
      this.main.focus()
      return this.main
    }
    const win = new BrowserWindow({
      width: 1120,
      height: 760,
      // Not on Linux: a tiling WM picks the size, and Electron lays the page out at its minimum and clips
      // it when the tile is smaller. The UI collapses the sidebar instead.
      ...(process.platform === 'darwin' && { minWidth: 780, minHeight: 500 }),
      show: false,
      title: 'Oatmeal',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
      backgroundColor: this.background(),
      webPreferences: this.webPreferences(),
    })
    win.once('ready-to-show', () => win.show())
    win.on('focus', () => this.onMainFocus?.())
    win.on('closed', () => {
      if (this.main === win) this.main = null
    })
    this.load(win, 'index')
    this.main = win
    return win
  }

  /**
   * Shows the main window on a given meeting (or settings) and brings Oatmeal to the front. If the window
   * is still loading, the renderer picks the target up with `takePendingNavigation()` once it has mounted.
   */
  navigate(target: OatmealEvents['navigate']) {
    const ready = this.main && !this.main.isDestroyed() && !this.main.webContents.isLoading()
    const win = this.showMain()
    // Only called at natural break points (a call just ended, a notification was clicked), so it's fine
    // to take focus from whatever app was in front.
    if (process.platform === 'darwin') app.focus({ steal: true })
    if (ready) win.webContents.send(eventChannel('navigate'), target)
    else this.pendingNavigation = target
  }

  /** True when the main window is the one the user is looking at. */
  get mainFocused(): boolean {
    return !!this.main && !this.main.isDestroyed() && this.main.isFocused()
  }

  takePendingNavigation(): OatmealEvents['navigate'] | null {
    const target = this.pendingNavigation
    this.pendingNavigation = null
    return target
  }

  /**
   * The small floating panel ("Transcribe this call?" / "Your notes are ready"). A non-activating panel, so
   * it never steals focus from whatever you're doing.
   */
  showPanel() {
    if (!this.panel || this.panel.isDestroyed()) {
      const width = 380
      const height = 160
      floatPanelOnHyprland()
      const { workArea } = screen.getPrimaryDisplay()
      const win = new BrowserWindow({
        width,
        height,
        x: workArea.x + workArea.width - width - 16,
        y: workArea.y + 16,
        frame: false,
        // Linux: Chromium applies GTK's text-scaling-factor (1.18 on Omarchy) to the page but not to the
        // fixed size it gives a non-resizable window, so Wayland clips the panel. Resizable sizes correctly.
        resizable: process.platform === 'linux',
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        title: PANEL_TITLE,
        type: process.platform === 'darwin' ? 'panel' : undefined,
        backgroundColor: this.background(),
        webPreferences: this.webPreferences(),
      })
      win.setAlwaysOnTop(true, 'floating')
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      win.on('page-title-updated', (event) => event.preventDefault()) // keep PANEL_TITLE for the Hyprland rule
      win.on('closed', () => {
        if (this.panel === win) this.panel = null
      })
      this.load(win, 'prompt')
      this.panel = win
      win.once('ready-to-show', () => win.showInactive())
      return
    }
    this.panel.showInactive()
  }

  hidePanel() {
    this.panel?.hide()
  }

  get panelWindow(): BrowserWindow | null {
    return this.panel && !this.panel.isDestroyed() ? this.panel : null
  }

  broadcast<K extends keyof OatmealEvents>(event: K, payload: OatmealEvents[K]) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(eventChannel(event), payload)
    }
  }
}

const PANEL_TITLE = 'Oatmeal Panel'

/**
 * Wayland ignores window positions, always-on-top and "show without focus", so on Hyprland the panel gets a
 * window rule instead: floating, pinned to every workspace, top-right, and never focused on open. Set at
 * runtime (and again each time, since a config reload drops it) so users don't have to edit their config.
 * No `size`: Electron sizes the panel itself, including GTK's text scaling.
 */
function floatPanelOnHyprland() {
  if (process.platform !== 'linux' || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return
  const rule = `hl.window_rule({ name = "oatmeal-call-panel", match = { title = "^${PANEL_TITLE}$" }, float = true, pin = true,
    no_initial_focus = true, move = { "(monitor_w-window_w-16)", "(monitor_h*0.04)" } })`
  execFile('hyprctl', ['eval', rule], (error, stdout) => {
    if (error || stdout.trim() !== 'ok') console.warn('[windows] could not add the Hyprland panel rule:', error?.message ?? stdout.trim())
  })
}
