import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { autostartDesktopEntry, HIDDEN_FLAG, launcherDesktopEntry } from '@shared/autostart'
import { app } from 'electron'
import { appImagePath, getPaths } from './paths'

/**
 * Open at login: Electron's login items on macOS, an XDG autostart entry on Linux. Packaged builds only: in dev
 * it would register the bare Electron binary.
 */
const supported = () => app.isPackaged && (process.platform === 'darwin' || process.platform === 'linux')

const autostartFile = () => {
  const xdg = process.env.XDG_CONFIG_HOME
  return path.join(
    xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config'),
    'autostart',
    'oatmeal.desktop',
  )
}

export function getOpenAtLogin(): boolean | null {
  if (!supported()) return null
  if (process.platform === 'linux') return fs.existsSync(autostartFile())
  return app.getLoginItemSettings().openAtLogin
}

export function setOpenAtLogin(open: boolean): boolean | null {
  if (!supported()) return null
  if (process.platform === 'darwin') app.setLoginItemSettings({ openAtLogin: open })
  else if (!open) fs.rmSync(autostartFile(), { force: true })
  else {
    fs.mkdirSync(path.dirname(autostartFile()), { recursive: true })
    // An AppImage runs from a temporary mount, so point at the .AppImage file itself.
    fs.writeFileSync(autostartFile(), autostartDesktopEntry(appImagePath() ?? process.execPath))
  }
  return getOpenAtLogin()
}

/** Re-point an existing Linux entry at this install: AppImage updates rename the file to the new version. */
export function refreshOpenAtLogin() {
  try {
    if (process.platform === 'linux' && getOpenAtLogin()) setOpenAtLogin(true)
  } catch (error) {
    console.error('failed to refresh the autostart entry', error)
  }
}

const dataHome = () => {
  const xdg = process.env.XDG_DATA_HOME
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.local', 'share')
}

/**
 * Puts the AppImage in the app launcher. It installs no launcher entry itself, so Oatmeal writes one (and copies its
 * icon) on every launch where the entry is missing or stale: AppImage updates rename the file to the new version.
 */
export function refreshLauncherEntry() {
  const appImage = appImagePath()
  if (!appImage) return
  try {
    const icon = path.join(dataHome(), 'icons', 'oatmeal.png')
    const file = path.join(dataHome(), 'applications', 'oatmeal.desktop')
    const entry = launcherDesktopEntry(appImage, icon)
    if (fs.existsSync(icon) && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === entry) return
    fs.mkdirSync(path.dirname(icon), { recursive: true })
    fs.copyFileSync(path.join(getPaths().resources, 'icon.png'), icon)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, entry)
  } catch (error) {
    console.error('failed to write the launcher entry', error)
  }
}

export const openedAtLogin = () =>
  process.platform === 'darwin' ? app.getLoginItemSettings().wasOpenedAtLogin : process.argv.includes(HIDDEN_FLAG)
