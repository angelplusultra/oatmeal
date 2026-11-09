import type { UpdateState, UpdateStatus } from '@shared/types'
import { app } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

const FIRST_CHECK_MS = 30_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

/** Why this install can't update itself, or null if it can. */
function unsupportedReason(): string | null {
  if (!app.isPackaged) return 'Updates are off when running from source.'
  if (process.platform === 'darwin') return null
  if (process.platform === 'linux' && process.env.APPIMAGE) return null
  if (process.platform === 'linux') return 'Update Oatmeal with your package manager.'
  return 'Updates are not available on this platform.'
}

/**
 * Checks GitHub Releases for a newer version and downloads it in the background (electron-updater).
 * It never interrupts: the update installs when Oatmeal quits, or when the user picks "Restart to update".
 * The only request is to GitHub, and it carries no meeting data. Turn it off with `settings.autoUpdate`.
 */
export class Updater {
  private status: UpdateStatus
  private timer: NodeJS.Timeout | null = null
  private enabled = false
  /** Set once "Restart to update" was chosen; the app is on its way out. */
  installing = false

  constructor(
    private readonly deps: {
      onChange(state: UpdateState): void
      /** A reason not to restart right now (e.g. a recording is running), or null. */
      busyReason(): string | null
    },
  ) {
    const reason = unsupportedReason()
    this.status = reason ? { kind: 'unsupported', reason } : { kind: 'idle', lastChecked: null }
    if (reason) return

    autoUpdater.autoDownload = true
    // On macOS this hands the download to Squirrel.Mac, which applies it the next time Oatmeal starts.
    // (Linux installs in installOnExit(): Oatmeal exits with app.exit, which skips the 'quit' event electron-updater waits for.)
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => this.set({ kind: 'checking' }))
    autoUpdater.on('update-not-available', () => this.set({ kind: 'idle', lastChecked: Date.now() }))
    autoUpdater.on('update-available', (info) => this.set({ kind: 'downloading', version: info.version, percent: 0 }))
    autoUpdater.on('download-progress', (progress) => {
      if (this.status.kind === 'downloading') this.set({ ...this.status, percent: Math.round(progress.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => this.set({ kind: 'ready', version: info.version }))
    autoUpdater.on('error', (error) => {
      // Offline is normal for a privacy-first app; say so plainly instead of dumping a stack.
      const message = String(error?.message ?? error).split('\n')[0]
      this.set({
        kind: 'error',
        message: /ENOTFOUND|ENETUNREACH|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|net::ERR_/.test(message)
          ? "Couldn't reach GitHub."
          : message,
      })
    })
  }

  get state(): UpdateState {
    return { currentVersion: app.getVersion(), status: this.status }
  }

  /** Turns background checks on or off. */
  setEnabled(enabled: boolean) {
    if (this.status.kind === 'unsupported' || enabled === this.enabled) return
    this.enabled = enabled
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!enabled) return
    const loop = () => {
      void this.check()
      this.timer = setTimeout(loop, CHECK_EVERY_MS)
    }
    this.timer = setTimeout(loop, FIRST_CHECK_MS)
  }

  /** Checks now (also when background checks are off: the user asked). */
  async check() {
    const { kind } = this.status
    if (kind === 'unsupported' || kind === 'checking' || kind === 'downloading' || kind === 'ready') return
    // Failures arrive through the 'error' event as well.
    await autoUpdater.checkForUpdates().catch(() => {})
  }

  install() {
    if (this.status.kind !== 'ready') throw new Error('No update has been downloaded yet')
    const busy = this.deps.busyReason()
    if (busy) throw new Error(busy)
    this.installing = true
    if (process.platform !== 'linux') {
      autoUpdater.quitAndInstall(false, true)
      return
    }
    // electron-updater would launch the new AppImage right away, while this instance still holds the
    // single-instance lock (shutdown takes a moment), so it would quit at once. Relaunch after exit instead.
    let destination = process.env.APPIMAGE!
    const renamed = (file: string) => (destination = file)
    const events = autoUpdater as unknown as NodeJS.EventEmitter
    events.once('appimage-filename-updated', renamed)
    autoUpdater.quitAndInstall(true, false)
    events.off('appimage-filename-updated', renamed)
    // A failed install is reported through the 'error' event, which changes the status.
    if ((this.status as UpdateStatus).kind === 'error') this.installing = false
    else app.relaunch({ execPath: destination, args: [] })
  }

  /** Called right before Oatmeal exits. Swaps in a downloaded AppImage; macOS needs nothing here. */
  installOnExit() {
    if (process.platform !== 'linux' || this.status.kind !== 'ready' || this.installing) return
    this.installing = true
    ;(autoUpdater as unknown as { install(isSilent: boolean, isForceRunAfter: boolean): boolean }).install(true, false)
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private set(status: UpdateStatus) {
    this.status = status
    this.deps.onChange(this.state)
  }
}
