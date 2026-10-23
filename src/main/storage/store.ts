import Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import { MIGRATIONS } from "./migrations";
import type { DictationRecord, DictionaryRow, NewDictation } from "@shared/types";

/**
 * SQLite store. Every user table has a UUID id plus created_at/updated_at/deleted_at so a
 * sync layer can be added later; deletes are soft and `purge*` methods remove rows for real.
 */
export class Store {
  readonly db: Database.Database;

  constructor(file: string, opts: { key?: string } = {}) {
    this.db = new Database(file);
    try {
      if (opts.key) {
        this.db.pragma(`cipher='sqlcipher'`);
        this.db.pragma(`key='${opts.key.replace(/'/g, "''")}'`);
      }
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.migrate();
    } catch (err) {
      this.db.close(); // a wrong key surfaces here; don't leave the file locked
      throw err;
    }
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- dictations ----

  addDictation(d: NewDictation): DictationRecord {
    const now = Date.now();
    const row: DictationRecord = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      rawText: d.rawText,
      cleanText: d.cleanText,
      mode: d.mode,
      engine: d.engine,
      model: d.model,
      durationMs: d.durationMs,
      latencyMs: d.latencyMs,
      appName: d.appName ?? null,
      cloudUsed: d.cloudUsed,
    };
    this.db
      .prepare(
        `INSERT INTO dictations (id, created_at, updated_at, raw_text, clean_text, mode, engine, model,
           duration_ms, latency_ms, app_name, cloud_used)
         VALUES (@id, @createdAt, @updatedAt, @rawText, @cleanText, @mode, @engine, @model,
           @durationMs, @latencyMs, @appName, @cloudUsed)`,
      )
      .run({ ...row, cloudUsed: row.cloudUsed ? 1 : 0 });
    return row;
  }

  listDictations(opts: { query?: string; limit?: number; offset?: number } = {}): DictationRecord[] {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const q = opts.query?.trim();
    const rows = q
      ? this.db
          .prepare(
            `SELECT d.* FROM dictations_fts f JOIN dictations d ON d.rowid = f.rowid
             WHERE dictations_fts MATCH ? AND d.deleted_at IS NULL
             ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
          )
          .all(toFtsQuery(q), limit, offset)
      : this.db
          .prepare(`SELECT * FROM dictations WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?`)
          .all(limit, offset);
    return (rows as DictationRow[]).map(fromRow);
  }

  getDictation(id: string): DictationRecord | null {
    const r = this.db.prepare(`SELECT * FROM dictations WHERE id = ? AND deleted_at IS NULL`).get(id);
    return r ? fromRow(r as DictationRow) : null;
  }

  deleteDictation(id: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE dictations SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
  }

  purgeDeleted(): void {
    this.db.prepare(`DELETE FROM dictations WHERE deleted_at IS NOT NULL`).run();
  }

  // ---- dictionary ----

  listDictionary(): DictionaryRow[] {
    return this.db
      .prepare(`SELECT id, term, match, replacement, kind FROM dictionary WHERE deleted_at IS NULL ORDER BY term`)
      .all() as DictionaryRow[];
  }

  upsertDictionary(e: Omit<DictionaryRow, "id"> & { id?: string }): DictionaryRow {
    const now = Date.now();
    const id = e.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO dictionary (id, term, match, replacement, kind, created_at, updated_at)
         VALUES (@id, @term, @match, @replacement, @kind, @now, @now)
         ON CONFLICT(id) DO UPDATE SET term = @term, match = @match, replacement = @replacement,
           kind = @kind, updated_at = @now, deleted_at = NULL`,
      )
      .run({ id, term: e.term, match: e.match ?? null, replacement: e.replacement ?? null, kind: e.kind, now });
    return { id, term: e.term, match: e.match ?? null, replacement: e.replacement ?? null, kind: e.kind };
  }

  deleteDictionary(id: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE dictionary SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
  }
}

/** Turn free text into a safe FTS5 prefix query: each word quoted, last one as a prefix. */
export function toFtsQuery(q: string): string {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter(Boolean);
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
}

interface DictationRow {
  id: string;
  created_at: number;
  updated_at: number;
  raw_text: string;
  clean_text: string;
  mode: DictationRecord["mode"];
  engine: string;
  model: string;
  duration_ms: number;
  latency_ms: number;
  app_name: string | null;
  cloud_used: number;
}

function fromRow(r: DictationRow): DictationRecord {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    rawText: r.raw_text,
    cleanText: r.clean_text,
    mode: r.mode,
    engine: r.engine,
    model: r.model,
    durationMs: r.duration_ms,
    latencyMs: r.latency_ms,
    appName: r.app_name,
    cloudUsed: !!r.cloud_used,
  };
}
