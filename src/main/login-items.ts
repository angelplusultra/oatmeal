import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { autostartDesktopEntry, HIDDEN_FLAG } from '@shared/autostart'
import { app } from 'electron'

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
    // An AppImage runs from a temporary mount; APPIMAGE is the file the user launched.
    fs.writeFileSync(autostartFile(), autostartDesktopEntry(process.env.APPIMAGE || process.execPath))
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

export const openedAtLogin = () =>
  process.platform === 'darwin' ? app.getLoginItemSettings().wasOpenedAtLogin : process.argv.includes(HIDDEN_FLAG)
