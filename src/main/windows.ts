import { app, BrowserWindow, nativeTheme, screen } from 'electron'
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
      minWidth: 780,
      minHeight: 500,
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
      const { workArea } = screen.getPrimaryDisplay()
      const win = new BrowserWindow({
        width,
        height,
        x: workArea.x + workArea.width - width - 16,
        y: workArea.y + 16,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        type: process.platform === 'darwin' ? 'panel' : undefined,
        backgroundColor: this.background(),
        webPreferences: this.webPreferences(),
      })
      win.setAlwaysOnTop(true, 'floating')
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
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
