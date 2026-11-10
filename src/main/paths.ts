import path from 'node:path'
import { app } from 'electron'

/** Where things live. Resources are bundled into the .app when packaged and read from ./resources in dev. */
export function getPaths() {
  const userData = app.getPath('userData')
  const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
  return {
    userData,
    db: path.join(userData, 'oatmeal.db'),
    models: path.join(userData, 'models'),
    resources,
    helper: path.join(resources, 'bin', 'oatmeal-audio'),
    moonshineLib: path.join(resources, 'moonshine', `${process.platform}-${process.arch}`),
    trayIcons: path.join(resources, 'tray'),
  }
}

export type Paths = ReturnType<typeof getPaths>

/**
 * The AppImage file Oatmeal runs from, or undefined. APPIMAGE alone isn't proof: it's inherited when Oatmeal is
 * started from inside another AppImage (a terminal in one, say). Ours mounts at APPDIR, around our executable.
 */
export function appImagePath(): string | undefined {
  const { APPIMAGE, APPDIR } = process.env
  return APPIMAGE && APPDIR && process.execPath.startsWith(APPDIR + path.sep) ? APPIMAGE : undefined
}
