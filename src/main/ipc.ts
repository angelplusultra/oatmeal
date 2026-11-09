import fs from 'node:fs'
import { INVOKE_METHODS, invokeChannel, type OatmealEvents, type OatmealInvoke } from '@shared/api'
import { renderSummaryMarkdown } from '@shared/summarize'
import { transcriptToJson, transcriptToMarkdown, transcriptToText } from '@shared/transcript'
import type { Settings } from '@shared/types'
import { clipboard, dialog, ipcMain, shell } from 'electron'
import type { Store } from './db'
import { getPermissions, openPermissionSettings } from './helper'
import { getOpenAtLogin, setOpenAtLogin } from './login-items'
import type { OmarchyThemeWatcher } from './omarchy'
import type { Orchestrator } from './orchestrator'
import type { Paths } from './paths'
import type { Updater } from './updater'
import type { WindowManager } from './windows'

interface IpcDeps {
  store: Store
  paths: Paths
  orchestrator: Orchestrator
  windows: WindowManager
  broadcast<K extends keyof OatmealEvents>(event: K, payload: OatmealEvents[K]): void
  getSettings(): Settings
  updateSettings(patch: Partial<Settings>): Settings
  updater: Updater
  omarchyTheme: OmarchyThemeWatcher
}

const slug = (s: string) =>
  s
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'meeting'

export function registerIpc(deps: IpcDeps) {
  const { store, orchestrator, windows, broadcast, updater } = deps
  const changed = (meetingId: string) => {
    broadcast('meeting-updated', { meetingId })
    broadcast('meetings-changed', null)
  }
  const requireMeeting = (id: string) => {
    const meeting = store.getMeeting(id)
    if (!meeting) throw new Error('Meeting not found')
    return meeting
  }

  const api: OatmealInvoke = {
    async listMeetings(query) {
      return store.listMeetings(query)
    },
    async getMeeting(id) {
      return store.getMeeting(id)
    },
    async getSegments(id) {
      return store.getSegments(id)
    },
    async renameMeeting(id, title) {
      store.updateMeeting(id, { title: title.trim() || 'Untitled meeting', titleAuto: false })
      changed(id)
    },
    async renameSpeaker(id, key, name) {
      const meeting = requireMeeting(id)
      const speakerNames = { ...meeting.speakerNames }
      if (name.trim()) speakerNames[key] = name.trim()
      else delete speakerNames[key]
      store.updateMeeting(id, { speakerNames })
      changed(id)
    },
    async deleteMeeting(id) {
      const state = orchestrator.getState()
      if ('meetingId' in state && state.meetingId === id) throw new Error('Stop the recording before deleting it')
      store.deleteMeeting(id)
      broadcast('meetings-changed', null)
    },
    async generateNotes(id) {
      requireMeeting(id)
      orchestrator.enqueueNotes(id)
    },
    async setActionItemDone(id, index, done) {
      const meeting = requireMeeting(id)
      if (!meeting.summary?.actionItems[index]) return
      meeting.summary.actionItems[index].done = done
      store.updateMeeting(id, { summary: meeting.summary })
      changed(id)
    },
    async exportMeeting(id, format) {
      const meeting = requireMeeting(id)
      const segments = store.getSegments(id)
      const base = slug(meeting.title)
      const outputs = {
        'notes-md': () => ({
          name: `${base}.md`,
          body: meeting.summary ? renderSummaryMarkdown(meeting.summary, meeting) : '',
        }),
        'transcript-txt': () => ({
          name: `${base}-transcript.txt`,
          body: `${transcriptToText(segments, meeting.speakerNames)}\n`,
        }),
        'transcript-md': () => ({
          name: `${base}-transcript.md`,
          body: transcriptToMarkdown(meeting.title, meeting.startedAt, segments, meeting.speakerNames),
        }),
        'transcript-json': () => ({
          name: `${base}-transcript.json`,
          body: JSON.stringify(
            {
              title: meeting.title,
              startedAt: new Date(meeting.startedAt).toISOString(),
              segments: transcriptToJson(segments, meeting.speakerNames),
            },
            null,
            2,
          ),
        }),
      }
      const { name, body } = outputs[format]()
      if (!body) throw new Error('Nothing to export yet')
      const result = windows.main
        ? await dialog.showSaveDialog(windows.main, { defaultPath: name })
        : await dialog.showSaveDialog({ defaultPath: name })
      if (result.canceled || !result.filePath) return false
      fs.writeFileSync(result.filePath, body)
      return true
    },
    async copyNotes(id) {
      const meeting = requireMeeting(id)
      if (!meeting.summary) throw new Error('No notes yet')
      clipboard.writeText(renderSummaryMarkdown(meeting.summary, meeting))
    },
    async startRecording() {
      await orchestrator.start(null)
    },
    async stopRecording() {
      await orchestrator.stop('user')
    },
    async getRecordingState() {
      return orchestrator.getState()
    },
    async getSettings() {
      return deps.getSettings()
    },
    async updateSettings(patch) {
      return deps.updateSettings(patch)
    },
    async getModelStatus() {
      return orchestrator.modelStatus()
    },
    async downloadModel(kind) {
      await orchestrator.downloadModel(kind)
    },
    async cancelDownload() {
      await orchestrator.cancelDownload()
    },
    async chooseModelFile() {
      const options: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        filters: [{ name: 'GGUF model', extensions: ['gguf'] }],
      }
      const result = windows.main
        ? await dialog.showOpenDialog(windows.main, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    async getPermissions() {
      return getPermissions(deps.paths.helper)
    },
    async requestPermission(kind) {
      return getPermissions(deps.paths.helper, kind)
    },
    async openPermissionSettings(kind) {
      await openPermissionSettings(kind)
    },
    async openDataFolder() {
      await shell.openPath(deps.paths.userData)
    },
    async getOpenAtLogin() {
      return getOpenAtLogin()
    },
    async setOpenAtLogin(open) {
      return setOpenAtLogin(open)
    },
    async getPanel() {
      return orchestrator.getPanel()
    },
    async respondToPanel(action) {
      await orchestrator.respondToPanel(action)
    },
    async takePendingNavigation() {
      return windows.takePendingNavigation()
    },
    async getUpdateState() {
      return updater.state
    },
    async checkForUpdates() {
      await updater.check()
    },
    async installUpdate() {
      updater.install()
    },
    async getOmarchyTheme() {
      return deps.omarchyTheme.current()
    },
  }

  for (const method of INVOKE_METHODS) {
    const fn = api[method] as (...args: unknown[]) => Promise<unknown>
    ipcMain.handle(invokeChannel(method), (_event, ...args: unknown[]) => fn(...args))
  }
}
