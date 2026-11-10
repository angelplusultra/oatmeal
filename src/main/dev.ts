/**
 * Development and end-to-end testing hooks, all opt-in through environment variables:
 *
 *   OATMEAL_FAKE_AUDIO="mic=/a.wav,system=/b.wav,speed=4"   play WAV files instead of live capture
 *   OATMEAL_AUTOSTART=1                                     start recording as soon as the app is ready
 *   OATMEAL_LLM_MODEL_PATH=/path/model.gguf                 use an existing GGUF for notes
 *   OATMEAL_SCREENSHOT_DIR=/dir                             save screenshots of the main window at milestones
 *   OATMEAL_EXIT_AFTER_NOTES=1                              quit once the first notes are written
 *   OATMEAL_USER_DATA=/dir                                  use a separate data directory
 *   OATMEAL_SETUP=asr,llm                                   download models at launch
 *   OATMEAL_DEMO_PROMPT=1|accept                            pretend Zoom started using the mic (and click Transcribe)
 *   OATMEAL_START_HIDDEN=1                                  don't open the main window at launch
 *   OATMEAL_DEMO_VIEW=1                                     click "View notes" on the notes-ready panel
 *   OATMEAL_START_VIEW=settings|<meetingId>                 open Settings, or a meeting, on launch
 *   OATMEAL_NO_OMARCHY_THEME=1                              keep Pantry's colors on Omarchy (e.g. for README screenshots)
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AudioSourceSpec } from '@shared/protocol'
import { app, type BrowserWindow } from 'electron'

export function fakeAudioFromEnv(): Extract<AudioSourceSpec, { kind: 'files' }> | undefined {
  const raw = process.env.OATMEAL_FAKE_AUDIO
  if (!raw) return undefined
  const spec: Extract<AudioSourceSpec, { kind: 'files' }> = { kind: 'files', speed: 1 }
  for (const part of raw.split(',')) {
    const [key, value] = part.split('=')
    if (key === 'mic' || key === 'system') spec[key] = value
    if (key === 'speed') spec.speed = Number(value) || 1
  }
  return spec
}

export function applyUserDataOverride() {
  if (process.env.OATMEAL_USER_DATA) app.setPath('userData', process.env.OATMEAL_USER_DATA)
}

export function createScreenshotter(getWindow: () => BrowserWindow | null, prefix = 'main') {
  const dir = process.env.OATMEAL_SCREENSHOT_DIR
  let n = 0
  return async (label: string) => {
    const win = getWindow()
    if (!dir || !win || win.isDestroyed()) return
    fs.mkdirSync(dir, { recursive: true })
    const image = await win.webContents.capturePage()
    const file = path.join(dir, `${prefix}-${String(++n).padStart(2, '0')}-${label}.png`)
    fs.writeFileSync(file, image.toPNG())
    console.log(`[dev] screenshot ${file}`)
  }
}
