/**
 * Thin wrappers around the macOS audio helper's one-shot commands. On Linux there is no helper: capture
 * and detection go through PipeWire's `pw-record` and `pactl`, and audio needs no permission.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import type { PermissionState, PermissionStatus } from '@shared/types'

const SETTINGS_URLS = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  systemAudio: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture',
}

const onPath = (bin: string) => (process.env.PATH ?? '').split(':').some((dir) => dir && fs.existsSync(path.join(dir, bin)))

export function helperAvailable(helperPath: string): boolean {
  if (process.platform === 'linux') return onPath('pactl') && onPath('pw-record')
  return process.platform === 'darwin' && fs.existsSync(helperPath)
}

export function getPermissions(helperPath: string, request?: 'microphone' | 'systemAudio'): Promise<PermissionStatus> {
  if (!helperAvailable(helperPath)) {
    return Promise.resolve({ microphone: 'unknown', systemAudio: 'unknown', helperAvailable: false })
  }
  if (process.platform === 'linux') return Promise.resolve({ microphone: 'granted', systemAudio: 'granted', helperAvailable: true })
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
