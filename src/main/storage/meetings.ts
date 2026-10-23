import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { MeetingSummary, SpeakerLabel, TranscriptLine } from "@shared/meeting/types";
import type { MeetingRecord, MeetingKind, MeetingStatus, PersonRecord } from "@shared/types";
import { toFtsQuery } from "./store";

const toBlob = (v: ArrayLike<number>) => Buffer.from(Float32Array.from(v).buffer);
const fromBlob = (b: Buffer | null) => (b ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null);

interface MeetingRow {
  id: string;
  title: string;
  kind: MeetingKind;
  status: MeetingStatus;
  started_at: number;
  ended_at: number | null;
  duration_ms: number;
  dir: string;
  audio_file: string | null;
  audio_encrypted: number;
  audio_expires_at: number | null;
  source_app: string | null;
  summary_json: string | null;
  attendees_json: string | null;
  calendar_event_id: string | null;
  error: string | null;
  recovered: number;
}

function fromRow(r: MeetingRow): MeetingRecord {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    dir: r.dir,
    audioFile: r.audio_file,
    audioEncrypted: !!r.audio_encrypted,
    audioExpiresAt: r.audio_expires_at,
    sourceApp: r.source_app,
    summary: r.summary_json ? (JSON.parse(r.summary_json) as MeetingSummary) : null,
    attendees: r.attendees_json ? (JSON.parse(r.attendees_json) as string[]) : [],
    calendarEventId: r.calendar_event_id,
    error: r.error,
    recovered: !!r.recovered,
  };
}

export class MeetingRepo {
  constructor(private readonly db: Database.Database) {}

  create(m: { title: string; kind: MeetingKind; dir: string; sourceApp?: string | null; startedAt?: number; id?: string }): MeetingRecord {
    const now = Date.now();
    const id = m.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO meetings (id, title, kind, status, started_at, dir, source_app, created_at, updated_at)
         VALUES (?, ?, ?, 'recording', ?, ?, ?, ?, ?)`,
      )
      .run(id, m.title, m.kind, m.startedAt ?? now, m.dir, m.sourceApp ?? null, now, now);
    return this.get(id)!;
  }

  get(id: string): MeetingRecord | null {
    const r = this.db.prepare(`SELECT * FROM meetings WHERE id = ? AND deleted_at IS NULL`).get(id) as MeetingRow | undefined;
    return r ? fromRow(r) : null;
  }

  list(opts: { query?: string; limit?: number } = {}): MeetingRecord[] {
    const q = opts.query?.trim();
    const rows = q
      ? (this.db
          .prepare(
            `SELECT DISTINCT m.* FROM meetings m
             LEFT JOIN meeting_lines l ON l.meeting_id = m.id
             WHERE m.deleted_at IS NULL AND (m.title LIKE ? OR l.rowid IN (SELECT rowid FROM meeting_lines_fts WHERE meeting_lines_fts MATCH ?))
             ORDER BY m.started_at DESC LIMIT ?`,
          )
          .all(`%${q}%`, toFtsQuery(q), opts.limit ?? 200) as MeetingRow[])
      : (this.db
          .prepare(`SELECT * FROM meetings WHERE deleted_at IS NULL ORDER BY started_at DESC LIMIT ?`)
          .all(opts.limit ?? 200) as MeetingRow[]);
    return rows.map(fromRow);
  }

  listByStatus(status: MeetingStatus): MeetingRecord[] {
    return (this.db.prepare(`SELECT * FROM meetings WHERE status = ? AND deleted_at IS NULL`).all(status) as MeetingRow[]).map(fromRow);
  }

  update(id: string, patch: Partial<{
    title: string;
    status: MeetingStatus;
    endedAt: number;
    durationMs: number;
    audioFile: string | null;
    audioEncrypted: boolean;
    audioExpiresAt: number | null;
    summary: MeetingSummary | null;
    attendees: string[];
    calendarEventId: string | null;
    error: string | null;
    recovered: boolean;
  }>): void {
    const cols: Record<string, unknown> = {
      title: patch.title,
      status: patch.status,
      ended_at: patch.endedAt,
      duration_ms: patch.durationMs,
      audio_file: patch.audioFile,
      audio_encrypted: patch.audioEncrypted === undefined ? undefined : patch.audioEncrypted ? 1 : 0,
      audio_expires_at: patch.audioExpiresAt,
      summary_json: patch.summary === undefined ? undefined : patch.summary ? JSON.stringify(patch.summary) : null,
      attendees_json: patch.attendees === undefined ? undefined : JSON.stringify(patch.attendees),
      calendar_event_id: patch.calendarEventId,
      error: patch.error,
      recovered: patch.recovered === undefined ? undefined : patch.recovered ? 1 : 0,
    };
    const set = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (!set.length) return;
    this.db
      .prepare(`UPDATE meetings SET ${set.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...set.map(([, v]) => v), Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare(`UPDATE meetings SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(Date.now(), Date.now(), id);
  }

  purge(id: string): void {
    this.db.prepare(`DELETE FROM meetings WHERE id = ?`).run(id);
  }

  // ---- transcript ----

  replaceLines(meetingId: string, lines: TranscriptLine[], isFinal: boolean): void {
    const ins = this.db.prepare(
      `INSERT INTO meeting_lines (id, meeting_id, start_ms, end_ms, speaker_key, channel, text, conf, overlap, uncertain, is_final)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM meeting_lines WHERE meeting_id = ?`).run(meetingId);
      for (const l of lines) {
        ins.run(`${meetingId}:${l.id}`, meetingId, l.start, l.end, l.speakerKey, l.channel, l.text, l.conf, l.overlap ? 1 : 0, l.uncertainSpeaker ? 1 : 0, isFinal ? 1 : 0);
      }
    })();
  }

  appendLine(meetingId: string, l: TranscriptLine): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO meeting_lines (id, meeting_id, start_ms, end_ms, speaker_key, channel, text, conf, overlap, uncertain, is_final)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(`${meetingId}:${l.id}`, meetingId, l.start, l.end, l.speakerKey, l.channel, l.text, l.conf, l.overlap ? 1 : 0, l.uncertainSpeaker ? 1 : 0);
  }

  lines(meetingId: string): TranscriptLine[] {
    const rows = this.db
      .prepare(`SELECT * FROM meeting_lines WHERE meeting_id = ? ORDER BY start_ms, end_ms`)
      .all(meetingId) as Array<{
      id: string;
      start_ms: number;
      end_ms: number;
      speaker_key: string;
      channel: TranscriptLine["channel"];
      text: string;
      conf: number;
      overlap: number;
      uncertain: number;
    }>;
    return rows.map((r) => ({
      id: r.id.slice(meetingId.length + 1),
      start: r.start_ms,
      end: r.end_ms,
      speakerKey: r.speaker_key,
      channel: r.channel,
      text: r.text,
      conf: r.conf,
      overlap: !!r.overlap,
      uncertainSpeaker: !!r.uncertain,
    }));
  }

  updateLineText(meetingId: string, lineId: string, text: string): void {
    this.db.prepare(`UPDATE meeting_lines SET text = ? WHERE id = ?`).run(text, `${meetingId}:${lineId}`);
  }

  /** Full-text hits across meetings, with surrounding meeting info, for cross-meeting Q&A. */
  searchLines(query: string, limit = 40): Array<{ meetingId: string; title: string; startedAt: number; start: number; speakerKey: string; text: string }> {
    return this.db
      .prepare(
        `SELECT l.meeting_id meetingId, m.title, m.started_at startedAt, l.start_ms start, l.speaker_key speakerKey, l.text
         FROM meeting_lines_fts f JOIN meeting_lines l ON l.rowid = f.rowid JOIN meetings m ON m.id = l.meeting_id
         WHERE meeting_lines_fts MATCH ? AND m.deleted_at IS NULL ORDER BY rank LIMIT ?`,
      )
      .all(toFtsQuery(query).replace(/" "/g, '" OR "'), limit) as never;
  }

  // ---- speakers ----

  setSpeakers(meetingId: string, labels: Array<SpeakerLabel & { embedding?: ArrayLike<number> | null; confirmed?: boolean }>): void {
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO meeting_speakers (meeting_id, speaker_key, name, person_id, score, confidence, confirmed, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM meeting_speakers WHERE meeting_id = ?`).run(meetingId);
      for (const l of labels) {
        ins.run(meetingId, l.key, l.name, l.personId, l.score, l.confidence, l.confirmed ? 1 : 0, l.embedding ? toBlob(l.embedding) : null);
      }
    })();
  }

  speakers(meetingId: string): Array<SpeakerLabel & { confirmed: boolean; embedding: Float32Array | null }> {
    const rows = this.db.prepare(`SELECT * FROM meeting_speakers WHERE meeting_id = ? ORDER BY speaker_key`).all(meetingId) as Array<{
      speaker_key: string;
      name: string;
      person_id: string | null;
      score: number | null;
      confidence: SpeakerLabel["confidence"];
      confirmed: number;
      embedding: Buffer | null;
    }>;
    return rows.map((r) => ({
      key: r.speaker_key,
      name: r.name,
      personId: r.person_id,
      score: r.score,
      confidence: r.confidence,
      confirmed: !!r.confirmed,
      embedding: fromBlob(r.embedding),
    }));
  }

  renameSpeaker(meetingId: string, key: string, name: string, personId: string | null): void {
    this.db
      .prepare(`UPDATE meeting_speakers SET name = ?, person_id = ?, confirmed = 1, confidence = 'high' WHERE meeting_id = ? AND speaker_key = ?`)
      .run(name, personId, meetingId, key);
  }

  /** Move one line to another speaker (manual correction). */
  setLineSpeaker(meetingId: string, lineId: string, key: string): void {
    this.db.prepare(`UPDATE meeting_lines SET speaker_key = ?, uncertain = 0 WHERE id = ?`).run(key, `${meetingId}:${lineId}`);
  }
}

export class PeopleRepo {
  constructor(private readonly db: Database.Database) {}

  list(): PersonRecord[] {
    return (
      this.db
        .prepare(
          `SELECT p.id, p.name, p.is_me isMe, (SELECT count(*) FROM voiceprints v WHERE v.person_id = p.id) voiceprints
           FROM people p WHERE p.deleted_at IS NULL ORDER BY p.is_me DESC, p.name`,
        )
        .all() as Array<{ id: string; name: string; isMe: number; voiceprints: number }>
    ).map((r) => ({ ...r, isMe: !!r.isMe }));
  }

  findByName(name: string): PersonRecord | null {
    return this.list().find((p) => p.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
  }

  me(): PersonRecord | null {
    return this.list().find((p) => p.isMe) ?? null;
  }

  create(name: string, isMe = false): PersonRecord {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO people (id, name, is_me, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(id, name.trim(), isMe ? 1 : 0, now, now);
    return { id, name: name.trim(), isMe, voiceprints: 0 };
  }

  rename(id: string, name: string): void {
    this.db.prepare(`UPDATE people SET name = ?, updated_at = ? WHERE id = ?`).run(name.trim(), Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM voiceprints WHERE person_id = ?`).run(id);
    this.db.prepare(`UPDATE people SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(Date.now(), Date.now(), id);
  }

  addVoiceprint(personId: string, embedding: ArrayLike<number>, model: string, source: "enrollment" | "meeting", meetingId?: string): void {
    // Keep the newest few per person: voices drift with microphones and rooms.
    this.db
      .prepare(`INSERT INTO voiceprints (id, person_id, embedding, model, source, source_meeting_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), personId, toBlob(embedding), model, source, meetingId ?? null, Date.now());
    this.db
      .prepare(
        `DELETE FROM voiceprints WHERE person_id = ? AND source = 'meeting' AND id NOT IN (
           SELECT id FROM voiceprints WHERE person_id = ? AND source = 'meeting' ORDER BY created_at DESC LIMIT 8)`,
      )
      .run(personId, personId);
  }

  clearVoiceprints(personId: string, source?: "enrollment" | "meeting"): void {
    if (source) this.db.prepare(`DELETE FROM voiceprints WHERE person_id = ? AND source = ?`).run(personId, source);
    else this.db.prepare(`DELETE FROM voiceprints WHERE person_id = ?`).run(personId);
  }

  /** Every person with their voice embeddings, for matching. */
  voices(model: string): Array<{ personId: string; name: string; isMe: boolean; embeddings: Float32Array[] }> {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.name, p.is_me, v.embedding FROM people p JOIN voiceprints v ON v.person_id = p.id
         WHERE p.deleted_at IS NULL AND v.model = ?`,
      )
      .all(model) as Array<{ id: string; name: string; is_me: number; embedding: Buffer }>;
    const map = new Map<string, { personId: string; name: string; isMe: boolean; embeddings: Float32Array[] }>();
    for (const r of rows) {
      if (!map.has(r.id)) map.set(r.id, { personId: r.id, name: r.name, isMe: !!r.is_me, embeddings: [] });
      map.get(r.id)!.embeddings.push(fromBlob(r.embedding)!);
    }
    return [...map.values()];
  }
}
