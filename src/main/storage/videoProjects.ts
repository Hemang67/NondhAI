import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { ProjectSpec, VideoProject } from "@shared/video/project";

interface Row {
  id: string;
  meeting_id: string;
  title: string;
  spec_json: string;
  export_file: string | null;
  export_status: VideoProject["exportStatus"];
  export_error: string | null;
  exported_at: number | null;
  created_at: number;
  updated_at: number;
}

const fromRow = (r: Row): VideoProject => ({
  id: r.id,
  meetingId: r.meeting_id,
  title: r.title,
  spec: JSON.parse(r.spec_json) as ProjectSpec,
  exportFile: r.export_file,
  exportStatus: r.export_status,
  exportError: r.export_error,
  exportedAt: r.exported_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class VideoProjectRepo {
  constructor(private readonly db: Database.Database) {}

  create(p: { meetingId: string; title: string; spec: ProjectSpec }): VideoProject {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO video_projects (id, meeting_id, title, spec_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, p.meetingId, p.title, JSON.stringify(p.spec), now, now);
    return this.get(id)!;
  }

  get(id: string): VideoProject | null {
    const r = this.db.prepare(`SELECT * FROM video_projects WHERE id = ?`).get(id) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  list(): VideoProject[] {
    // Edits of a deleted meeting go with it.
    return (
      this.db
        .prepare(
          `SELECT v.* FROM video_projects v JOIN meetings m ON m.id = v.meeting_id WHERE m.deleted_at IS NULL ORDER BY v.updated_at DESC`,
        )
        .all() as Row[]
    ).map(fromRow);
  }

  forMeeting(meetingId: string): VideoProject[] {
    return (this.db.prepare(`SELECT * FROM video_projects WHERE meeting_id = ? ORDER BY updated_at DESC`).all(meetingId) as Row[]).map(fromRow);
  }

  update(id: string, patch: { title?: string; spec?: ProjectSpec }): VideoProject | null {
    const cur = this.get(id);
    if (!cur) return null;
    this.db
      .prepare(`UPDATE video_projects SET title = ?, spec_json = ?, updated_at = ? WHERE id = ?`)
      .run(patch.title?.trim() || cur.title, JSON.stringify(patch.spec ?? cur.spec), Date.now(), id);
    return this.get(id);
  }

  setExport(id: string, e: { status: VideoProject["exportStatus"]; file?: string | null; error?: string | null }): void {
    const cur = this.get(id);
    if (!cur) return;
    this.db
      .prepare(`UPDATE video_projects SET export_status = ?, export_file = ?, export_error = ?, exported_at = ? WHERE id = ?`)
      .run(e.status, e.file === undefined ? cur.exportFile : e.file, e.error ?? null, e.status === "done" ? Date.now() : cur.exportedAt, id);
  }

  /** Exports left "rendering" by a crash or quit. */
  interrupted(): VideoProject[] {
    return (this.db.prepare(`SELECT * FROM video_projects WHERE export_status = 'rendering'`).all() as Row[]).map(fromRow);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM video_projects WHERE id = ?`).run(id);
  }
}
