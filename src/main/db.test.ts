import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/models'
import { Store } from './db'

let dir: string
let store: Store

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oatmeal-db-'))
  store = new Store(path.join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function seed(id: string, title: string, startedAt: number, lines: string[]) {
  store.createMeeting({ id, title, sourceApp: 'Zoom', startedAt, asrModel: 'test' })
  lines.forEach((text, i) =>
    store.insertSegment({ meetingId: id, lineId: `mic:${i}`, channel: 'mic', speaker: 'me', startMs: i * 1000, endMs: i * 1000 + 900, text, echo: false }),
  )
}

describe('Store', () => {
  it('lists newest first and searches titles and transcripts', () => {
    seed('a', 'Pricing sync', 1000, ['We discussed the enterprise tier.'])
    seed('b', 'Hiring', 2000, ['Finance must approve the designer budget.'])
    expect(store.listMeetings().map((m) => m.id)).toEqual(['b', 'a'])
    expect(store.listMeetings('pricing').map((m) => m.id)).toEqual(['a'])
    expect(store.listMeetings('design').map((m) => m.id)).toEqual(['b']) // prefix match in transcript
    expect(store.listMeetings('"); DROP TABLE meetings; --').map((m) => m.id)).toEqual([])
    expect(store.listMeetings('nothing-matches')).toEqual([])
  })

  it('ignores duplicate lines and updates speakers and echo flags', () => {
    seed('a', 'Sync', 0, ['Hello there.'])
    expect(
      store.insertSegment({ meetingId: 'a', lineId: 'mic:0', channel: 'mic', speaker: 'me', startMs: 0, endMs: 1, text: 'dup', echo: false }),
    ).toBeNull()
    const updated = store.updateSegment('a', 'mic:0', { speaker: 'sys:1', echo: true })
    expect(updated).toMatchObject({ speaker: 'sys:1', echo: true, text: 'Hello there.' })
  })

  it('round-trips summaries, speaker names and the map cache, and cascades deletes', () => {
    seed('a', 'Sync', 0, ['Hello.'])
    store.updateMeeting('a', {
      status: 'done',
      speakerNames: { 'sys:0': 'Priya' },
      summary: { title: 'T', tldr: 'x', keyPoints: [], decisions: [], actionItems: [], openQuestions: [], generatedAt: 1, model: 'm' },
    })
    store.saveMapCache('a', { k1: { topics: [] } })
    const meeting = store.getMeeting('a')!
    expect(meeting.status).toBe('done')
    expect(meeting.speakerNames).toEqual({ 'sys:0': 'Priya' })
    expect(meeting.summary?.title).toBe('T')
    expect(store.getMapCache('a')).toEqual({ k1: { topics: [] } })

    store.deleteMeeting('a')
    expect(store.getMeeting('a')).toBeNull()
    expect(store.getSegments('a')).toEqual([])
    expect(store.getMapCache('a')).toEqual({})
    expect(store.listMeetings('hello')).toEqual([])
  })

  it('finds meetings interrupted mid-recording', () => {
    seed('a', 'Sync', 0, ['Hi.'])
    expect(store.unfinishedMeetings().map((m) => m.id)).toEqual(['a'])
    store.updateMeeting('a', { status: 'transcribed' })
    expect(store.unfinishedMeetings()).toEqual([])
  })

  it('merges saved settings over defaults', () => {
    const defaults = defaultSettings({ cpuCount: 8, totalMemGB: 16 })
    expect(store.getSettings(defaults)).toEqual(defaults)
    store.saveSettings({ ...defaults, autoStopSeconds: 30 })
    expect(store.getSettings(defaults).autoStopSeconds).toBe(30)
    expect(defaults.asrModel).toBe('small')
    expect(defaultSettings({ cpuCount: 14, totalMemGB: 64 }).asrModel).toBe('medium')
  })
})
