import { app, Menu, nativeImage, nativeTheme, Tray } from 'electron'
import path from 'node:path'
import type { RecordingState } from '@shared/types'

/** Menu bar icon: shows whether Oatmeal is recording and offers start/stop. */
export class AppTray {
  private readonly tray: Tray
  private readonly template: Electron.NativeImage
  private readonly recordingIcon: Electron.NativeImage
  private timer: NodeJS.Timeout | null = null
  private recording = false

  constructor(
    iconDir: string,
    private readonly actions: { start(): void; stop(): void; open(): void },
  ) {
    this.template = nativeImage.createFromPath(path.join(iconDir, 'trayTemplate.png'))
    this.template.setTemplateImage(true)
    this.recordingIcon = nativeImage.createFromPath(path.join(iconDir, 'recording.png'))
    this.tray = new Tray(this.idleIcon())
    this.tray.setToolTip('Oatmeal')
    this.update({ kind: 'idle' })
    // On Linux the desktop's color scheme arrives after launch (and changes with Omarchy themes).
    nativeTheme.on('updated', () => {
      if (!this.recording) this.tray.setImage(this.idleIcon())
    })
  }

  /** Only macOS recolors template images. Elsewhere, paint the black glyph to suit the bar. */
  private idleIcon(): Electron.NativeImage {
    if (process.platform === 'darwin') return this.template
    return tint(this.template, nativeTheme.shouldUseDarkColors ? 255 : 0)
  }

  update(state: RecordingState) {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const recording = state.kind === 'recording'
    this.recording = recording
    this.tray.setImage(recording ? this.recordingIcon : this.idleIcon())
    const render = () => {
      let status = 'Not recording'
      if (state.kind === 'recording') {
        const seconds = Math.floor((Date.now() - state.startedAt) / 1000)
        const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
        status = `Recording${state.sourceApp ? ` ${state.sourceApp}` : ''} · ${clock}`
      } else if (state.kind === 'starting') status = 'Starting…'
      else if (state.kind === 'stopping') status = 'Finishing transcript…'
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: status, enabled: false },
          { type: 'separator' },
          recording
            ? { label: 'Stop transcribing', click: () => this.actions.stop() }
            : { label: 'Start transcribing', enabled: state.kind === 'idle', click: () => this.actions.start() },
          { label: 'Open Oatmeal', click: () => this.actions.open() },
          { type: 'separator' },
          { label: 'Quit Oatmeal', role: 'quit' },
        ]),
      )
    }
    render()
    if (recording) this.timer = setInterval(render, 15_000)
    if (process.platform === 'darwin') app.dock?.setBadge(recording ? '●' : '')
  }

  destroy() {
    if (this.timer) clearInterval(this.timer)
    this.tray.destroy()
  }
}

/** Same alpha, every pixel set to one gray level. The bitmap is premultiplied BGRA. */
function tint(image: Electron.NativeImage, level: number): Electron.NativeImage {
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  for (let i = 0; i < bitmap.length; i += 4) bitmap.fill(Math.round((level * bitmap[i + 3]) / 255), i, i + 3)
  return nativeImage.createFromBitmap(bitmap, { width, height })
}
