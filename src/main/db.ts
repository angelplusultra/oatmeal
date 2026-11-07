/** Local storage: one SQLite file (Node's built-in node:sqlite, with FTS5 for transcript search). */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Meeting, MeetingListItem, MeetingStatus, MeetingSummary, Segment, Settings, SpeakerKey } from '@shared/types'

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    title_auto INTEGER NOT NULL DEFAULT 1,
    source_app TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL,
    summary_json TEXT,
    error TEXT,
    asr_model TEXT,
    speaker_names TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX meetings_started ON meetings(started_at DESC);

  CREATE TABLE segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    line_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    speaker TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    echo INTEGER NOT NULL DEFAULT 0,
    UNIQUE (meeting_id, line_id)
  );
  CREATE INDEX segments_meeting ON segments(meeting_id, start_ms);

  CREATE VIRTUAL TABLE segments_fts USING fts5(text, content='segments', content_rowid='id');
  CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
    INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
    INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;

  CREATE TABLE map_cache (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (meeting_id, key)
  );

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
]

interface MeetingRow {
  id: string
  title: string
  title_auto: number
  source_app: string | null
  started_at: number
  ended_at: number | null
  status: MeetingStatus
  summary_json: string | null
  error: string | null
  asr_model: string | null
  speaker_names: string
}

interface SegmentRow {
  id: number
  meeting_id: string
  line_id: string
  channel: Segment['channel']
  speaker: string
  start_ms: number
  end_ms: number
  text: string
  echo: number
}

const toSegment = (r: SegmentRow): Segment => ({
  id: r.id,
  meetingId: r.meeting_id,
  lineId: r.line_id,
  channel: r.channel,
  speaker: r.speaker,
  startMs: r.start_ms,
  endMs: r.end_ms,
  text: r.text,
  echo: r.echo === 1,
})

const toMeeting = (r: MeetingRow): Meeting => ({
  id: r.id,
  title: r.title,
  sourceApp: r.source_app,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  status: r.status,
  summary: r.summary_json ? (JSON.parse(r.summary_json) as MeetingSummary) : null,
  error: r.error,
  asrModel: r.asr_model,
  speakerNames: JSON.parse(r.speaker_names || '{}') as Record<SpeakerKey, string>,
})

/** Turns free text into a safe FTS5 prefix query: each word quoted, last one as a prefix. */
function ftsQuery(query: string): string | null {
  const terms = query.match(/[\p{L}\p{N}']+/gu)
  if (!terms?.length) return null
  return terms.map((t, i) => `"${t.replace(/"/g, '')}"${i === terms.length - 1 ? '*' : ''}`).join(' ')
}

export class Store {
  private readonly db: DatabaseSync

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;')
    this.migrate()
  }

  private migrate() {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[v])
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  close() {
    this.db.close()
  }

  // ------------------------------------------------------------------ meetings

  createMeeting(m: { id: string; title: string; sourceApp: string | null; startedAt: number; asrModel: string }) {
    this.db
      .prepare('INSERT INTO meetings (id, title, source_app, started_at, status, asr_model) VALUES (?, ?, ?, ?, ?, ?)')
      .run(m.id, m.title, m.sourceApp, m.startedAt, 'recording', m.asrModel)
  }

  getMeeting(id: string): Meeting | null {
    const row = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as MeetingRow | undefined
    return row ? toMeeting(row) : null
  }

  isTitleAuto(id: string): boolean {
    const row = this.db.prepare('SELECT title_auto FROM meetings WHERE id = ?').get(id) as { title_auto: number } | undefined
    return row?.title_auto === 1
  }

  listMeetings(query?: string): MeetingListItem[] {
    const columns = 'id, title, source_app AS sourceApp, started_at AS startedAt, ended_at AS endedAt, status'
    const q = query?.trim()
    if (!q) return this.db.prepare(`SELECT ${columns} FROM meetings ORDER BY started_at DESC`).all() as unknown as MeetingListItem[]
    const like = `%${q.replace(/[%_]/g, '')}%`
    const fts = ftsQuery(q)
    const transcriptMatch = fts
      ? `OR id IN (SELECT s.meeting_id FROM segments_fts f JOIN segments s ON s.id = f.rowid WHERE segments_fts MATCH ?)`
      : ''
    const sql = `SELECT ${columns} FROM meetings WHERE title LIKE ? OR summary_json LIKE ? ${transcriptMatch} ORDER BY started_at DESC`
    const params = fts ? [like, like, fts] : [like, like]
    return this.db.prepare(sql).all(...params) as unknown as MeetingListItem[]
  }

  updateMeeting(
    id: string,
    patch: Partial<{ title: string; titleAuto: boolean; endedAt: number | null; status: MeetingStatus; summary: MeetingSummary | null; error: string | null; speakerNames: Record<string, string> }>,
  ) {
    const sets: string[] = []
    const values: (string | number | null)[] = []
    const set = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`)
      values.push(value)
    }
    if (patch.title !== undefined) set('title', patch.title)
    if (patch.titleAuto !== undefined) set('title_auto', patch.titleAuto ? 1 : 0)
    if (patch.endedAt !== undefined) set('ended_at', patch.endedAt)
    if (patch.status !== undefined) set('status', patch.status)
    if (patch.summary !== undefined) set('summary_json', patch.summary ? JSON.stringify(patch.summary) : null)
    if (patch.error !== undefined) set('error', patch.error)
    if (patch.speakerNames !== undefined) set('speaker_names', JSON.stringify(patch.speakerNames))
    if (!sets.length) return
    this.db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  }

  deleteMeeting(id: string) {
    this.db.prepare('DELETE FROM meetings WHERE id = ?').run(id)
  }

  /** Meetings left mid-recording or mid-summary by a crash or force-quit. */
  unfinishedMeetings(): Meeting[] {
    const rows = this.db.prepare(`SELECT * FROM meetings WHERE status IN ('recording', 'summarizing')`).all() as unknown as MeetingRow[]
    return rows.map(toMeeting)
  }

  // ------------------------------------------------------------------ segments

  insertSegment(s: Omit<Segment, 'id'>): Segment | null {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO segments (meeting_id, line_id, channel, speaker, start_ms, end_ms, text, echo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.meetingId, s.lineId, s.channel, s.speaker, s.startMs, s.endMs, s.text, s.echo ? 1 : 0)
    if (!result.changes) return null
    return { ...s, id: Number(result.lastInsertRowid) }
  }

  updateSegment(meetingId: string, lineId: string, patch: { speaker?: string; echo?: boolean }): Segment | null {
    if (patch.speaker !== undefined) {
      this.db.prepare('UPDATE segments SET speaker = ? WHERE meeting_id = ? AND line_id = ?').run(patch.speaker, meetingId, lineId)
    }
    if (patch.echo !== undefined) {
      this.db.prepare('UPDATE segments SET echo = ? WHERE meeting_id = ? AND line_id = ?').run(patch.echo ? 1 : 0, meetingId, lineId)
    }
    const row = this.db.prepare('SELECT * FROM segments WHERE meeting_id = ? AND line_id = ?').get(meetingId, lineId) as SegmentRow | undefined
    return row ? toSegment(row) : null
  }

  getSegments(meetingId: string): Segment[] {
    const rows = this.db.prepare('SELECT * FROM segments WHERE meeting_id = ? ORDER BY start_ms, id').all(meetingId) as unknown as SegmentRow[]
    return rows.map(toSegment)
  }

  lastSegmentEnd(meetingId: string): number | null {
    const row = this.db.prepare('SELECT MAX(end_ms) AS end FROM segments WHERE meeting_id = ?').get(meetingId) as { end: number | null }
    return row.end
  }

  // ------------------------------------------------------------------ map cache

  getMapCache(meetingId: string): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, json FROM map_cache WHERE meeting_id = ?').all(meetingId) as unknown as { key: string; json: string }[]
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.json)]))
  }

  saveMapCache(meetingId: string, cache: Record<string, unknown>) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO map_cache (meeting_id, key, json) VALUES (?, ?, ?)')
    this.db.exec('BEGIN')
    try {
      for (const [key, value] of Object.entries(cache)) stmt.run(meetingId, key, JSON.stringify(value))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ------------------------------------------------------------------ settings

  getSettings(defaults: Settings): Settings {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'settings'`).get() as { value: string } | undefined
    return { ...defaults, ...(row ? (JSON.parse(row.value) as Partial<Settings>) : {}) }
  }

  saveSettings(settings: Settings) {
    this.db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('settings', ?)`).run(JSON.stringify(settings))
  }
}
