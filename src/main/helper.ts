/** Thin wrappers around the macOS audio helper's one-shot commands. */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { shell } from 'electron'
import type { PermissionState, PermissionStatus } from '@shared/types'

const SETTINGS_URLS = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  systemAudio: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture',
}

export function helperAvailable(helperPath: string): boolean {
  return process.platform === 'darwin' && fs.existsSync(helperPath)
}

export function getPermissions(helperPath: string, request?: 'microphone' | 'systemAudio'): Promise<PermissionStatus> {
  if (!helperAvailable(helperPath)) {
    return Promise.resolve({ microphone: 'unknown', systemAudio: 'unknown', helperAvailable: false })
  }
  const args = ['permissions', ...(request ? ['--request', request === 'microphone' ? 'mic' : 'system'] : [])]
  return new Promise((resolve) => {
    execFile(helperPath, args, { timeout: request ? 130_000 : 10_000 }, (error, stdout) => {
      if (error) {
        resolve({ microphone: 'unknown', systemAudio: 'unknown', helperAvailable: true })
        return
      }
      try {
        const parsed = JSON.parse(stdout) as { microphone: PermissionState; systemAudio: PermissionState }
        resolve({ ...parsed, helperAvailable: true })
      } catch {
        resolve({ microphone: 'unknown', systemAudio: 'unknown', helperAvailable: true })
      }
    })
  })
}

export function openPermissionSettings(kind: 'microphone' | 'systemAudio') {
  return shell.openExternal(SETTINGS_URLS[kind])
}
