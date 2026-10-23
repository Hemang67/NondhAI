import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { FolderRecord, NoteRecord } from "@shared/notes";
import { toFtsQuery } from "./store";

interface NoteRow {
  id: string;
  folder_id: string | null;
  title: string;
  body_json: string;
  body_text: string;
  source_type: NoteRecord["sourceType"];
  source_id: string | null;
  created_at: number;
  updated_at: number;
}

const fromRow = (r: NoteRow): NoteRecord => ({
  id: r.id,
  folderId: r.folder_id,
  title: r.title,
  bodyJson: r.body_json,
  bodyText: r.body_text,
  sourceType: r.source_type,
  sourceId: r.source_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Plain text → minimal TipTap document (one paragraph per line). */
export function textToDoc(text: string): string {
  const paragraphs = text.split("\n").map((line) => ({
    type: "paragraph",
    ...(line ? { content: [{ type: "text", text: line }] } : {}),
  }));
  return JSON.stringify({ type: "doc", content: paragraphs });
}

export class NotesRepo {
  constructor(private readonly db: Database.Database) {}

  list(opts: { folderId?: string | null; query?: string } = {}): NoteRecord[] {
    const q = opts.query?.trim();
    if (q) {
      return (
        this.db
          .prepare(
            `SELECT n.* FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
             WHERE notes_fts MATCH ? AND n.deleted_at IS NULL ORDER BY rank LIMIT 200`,
          )
          .all(toFtsQuery(q)) as NoteRow[]
      ).map(fromRow);
    }
    const rows =
      opts.folderId === undefined
        ? this.db.prepare(`SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC`).all()
        : opts.folderId === null
          ? this.db.prepare(`SELECT * FROM notes WHERE deleted_at IS NULL AND folder_id IS NULL ORDER BY updated_at DESC`).all()
          : this.db.prepare(`SELECT * FROM notes WHERE deleted_at IS NULL AND folder_id = ? ORDER BY updated_at DESC`).all(opts.folderId);
    return (rows as NoteRow[]).map(fromRow);
  }

  get(id: string): NoteRecord | null {
    const r = this.db.prepare(`SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL`).get(id) as NoteRow | undefined;
    return r ? fromRow(r) : null;
  }

  bySource(type: "meeting" | "dictation", id: string): NoteRecord | null {
    const r = this.db
      .prepare(`SELECT * FROM notes WHERE source_type = ? AND source_id = ? AND deleted_at IS NULL`)
      .get(type, id) as NoteRow | undefined;
    return r ? fromRow(r) : null;
  }

  create(n: {
    title?: string;
    folderId?: string | null;
    bodyJson?: string;
    bodyText?: string;
    sourceType?: NoteRecord["sourceType"];
    sourceId?: string | null;
  }): NoteRecord {
    const id = randomUUID();
    const now = Date.now();
    const text = n.bodyText ?? "";
    this.db
      .prepare(
        `INSERT INTO notes (id, folder_id, title, body_json, body_text, source_type, source_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, n.folderId ?? null, n.title?.trim() || "Untitled", n.bodyJson ?? textToDoc(text), text, n.sourceType ?? null, n.sourceId ?? null, now, now);
    return this.get(id)!;
  }

  update(id: string, p: { title?: string; folderId?: string | null; bodyJson?: string; bodyText?: string }): NoteRecord {
    const cur = this.get(id);
    if (!cur) throw new Error("note not found");
    this.db
      .prepare(`UPDATE notes SET title = ?, folder_id = ?, body_json = ?, body_text = ?, updated_at = ? WHERE id = ?`)
      .run(
        p.title ?? cur.title,
        p.folderId === undefined ? cur.folderId : p.folderId,
        p.bodyJson ?? cur.bodyJson,
        p.bodyText ?? cur.bodyText,
        Date.now(),
        id,
      );
    return this.get(id)!;
  }

  delete(id: string): void {
    this.db.prepare(`UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(Date.now(), Date.now(), id);
  }

  // ---- folders ----

  folders(): FolderRecord[] {
    return this.db
      .prepare(`SELECT id, name, parent_id parentId FROM folders WHERE deleted_at IS NULL ORDER BY name`)
      .all() as FolderRecord[];
  }

  createFolder(name: string, parentId: string | null = null): FolderRecord {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(id, name.trim() || "New folder", parentId, now, now);
    return { id, name: name.trim() || "New folder", parentId };
  }

  renameFolder(id: string, name: string): void {
    this.db.prepare(`UPDATE folders SET name = ?, updated_at = ? WHERE id = ?`).run(name.trim(), Date.now(), id);
  }

  /** Deleting a folder keeps its notes (they move to "No folder") and lifts its subfolders up. */
  deleteFolder(id: string): void {
    const f = this.db.prepare(`SELECT parent_id FROM folders WHERE id = ?`).get(id) as { parent_id: string | null } | undefined;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE notes SET folder_id = NULL, updated_at = ? WHERE folder_id = ?`).run(Date.now(), id);
      this.db.prepare(`UPDATE folders SET parent_id = ? WHERE parent_id = ?`).run(f?.parent_id ?? null, id);
      this.db.prepare(`UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(Date.now(), Date.now(), id);
    })();
  }

  // ---- embeddings ----

  setEmbeddings(ownerType: string, ownerId: string, chunks: Array<{ text: string; vector: Float32Array }>, model: string): void {
    const ins = this.db.prepare(`INSERT INTO embeddings (owner_type, owner_id, chunk, text, vector, model, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM embeddings WHERE owner_type = ? AND owner_id = ?`).run(ownerType, ownerId);
      chunks.forEach((c, i) => ins.run(ownerType, ownerId, i, c.text, Buffer.from(c.vector.buffer, c.vector.byteOffset, c.vector.byteLength), model, Date.now()));
    })();
  }

  /** Vectors from another embedding model aren't comparable; drop them after a model change. */
  dropEmbeddingsExcept(model: string): void {
    this.db.prepare(`DELETE FROM embeddings WHERE model <> ?`).run(model);
  }

  removeEmbeddings(ownerType: string, ownerId: string): void {
    this.db.prepare(`DELETE FROM embeddings WHERE owner_type = ? AND owner_id = ?`).run(ownerType, ownerId);
  }

  allEmbeddings(model: string): Array<{ ownerType: string; ownerId: string; chunk: number; text: string; v: Float32Array }> {
    return (
      this.db.prepare(`SELECT owner_type, owner_id, chunk, text, vector FROM embeddings WHERE model = ?`).all(model) as Array<{
        owner_type: string;
        owner_id: string;
        chunk: number;
        text: string;
        vector: Buffer;
      }>
    ).map((r) => ({
      ownerType: r.owner_type,
      ownerId: r.owner_id,
      chunk: r.chunk,
      text: r.text,
      v: new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength)),
    }));
  }

  /** Owners whose content changed after their embeddings were made (or never embedded). */
  staleOwners(model: string): Array<{ type: "note" | "meeting" | "dictation"; id: string }> {
    return this.db
      .prepare(
        `SELECT 'note' type, id FROM notes n WHERE deleted_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM embeddings e WHERE e.owner_type = 'note' AND e.owner_id = n.id AND e.model = ? AND e.updated_at >= n.updated_at)
         UNION ALL
         SELECT 'meeting', id FROM meetings m WHERE deleted_at IS NULL AND status = 'ready' AND NOT EXISTS (
           SELECT 1 FROM embeddings e WHERE e.owner_type = 'meeting' AND e.owner_id = m.id AND e.model = ? AND e.updated_at >= m.updated_at)
         UNION ALL
         SELECT 'dictation', id FROM dictations d WHERE deleted_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM embeddings e WHERE e.owner_type = 'dictation' AND e.owner_id = d.id AND e.model = ?)`,
      )
      .all(model, model, model) as Array<{ type: "note" | "meeting" | "dictation"; id: string }>;
  }
}
