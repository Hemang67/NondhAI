import { join } from "node:path";
import { existsSync } from "node:fs";
import { chunkText, rrf, topK, type SearchHit } from "@shared/notes";
import { transcriptForLlm } from "@shared/meeting/export";
import type { LlamaServer } from "../llm/llamaServer";
import type { NotesRepo } from "../storage/notes";
import type { MeetingRepo } from "../storage/meetings";
import type { Store } from "../storage/store";
import { toFtsQuery } from "../storage/store";
import { log } from "../log";

const MODEL = "bge-small-en-v1.5";
const MODEL_FILE = "bge-small-en-v1.5-q8_0.gguf";
// BGE was trained on 512-token passages; ~800 characters keeps chunks focused.
const CHUNK = 800;
// BGE expects this instruction on queries (not on passages) for retrieval.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
// BGE similarities are compressed (unrelated text still scores ~0.45): rank matters more than
// the absolute score, so the floor only drops clearly unrelated chunks.
const MIN_SCORE = 0.5;

/**
 * Hybrid search over notes, meetings and dictations: SQLite FTS5 keywords plus local semantic
 * embeddings (MiniLM via llama-server), merged with Reciprocal Rank Fusion. If the embedding
 * model is missing or fails, search silently falls back to keywords only.
 */
export class SearchService {
  private indexing = false;

  constructor(
    private readonly d: {
      embedServer: LlamaServer;
      modelsDir: () => string;
      notes: NotesRepo;
      meetings: MeetingRepo;
      store: Store;
    },
  ) {}

  private get modelFile(): string {
    return join(this.d.modelsDir(), "llm", MODEL_FILE);
  }

  get semanticAvailable(): boolean {
    return existsSync(this.modelFile);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const base = await this.d.embedServer.ensure(this.modelFile, false);
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const r = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: texts.slice(i, i + 16), model: MODEL }),
      });
      if (!r.ok) throw new Error(`embeddings ${r.status}: ${await r.text()}`);
      const j = (await r.json()) as { data: Array<{ embedding: number[]; index: number }> };
      for (const e of j.data.sort((a, b) => a.index - b.index)) out.push(Float32Array.from(e.embedding));
    }
    return out;
  }

  /** Embed anything that changed since it was last indexed. Safe to call often. */
  async reindex(): Promise<number> {
    if (this.indexing || !this.semanticAvailable) return 0;
    this.indexing = true;
    let n = 0;
    try {
      this.d.notes.dropEmbeddingsExcept(MODEL);
      for (const owner of this.d.notes.staleOwners(MODEL)) {
        const text = this.ownerText(owner.type, owner.id);
        const chunks = chunkText(text, CHUNK);
        if (!chunks.length) {
          this.d.notes.setEmbeddings(owner.type, owner.id, [], MODEL);
          continue;
        }
        const vectors = await this.embed(chunks);
        this.d.notes.setEmbeddings(owner.type, owner.id, chunks.map((t, i) => ({ text: t, vector: vectors[i]! })), MODEL);
        n++;
      }
      if (n) log.info(`search index: embedded ${n} items`);
    } catch (err) {
      log.warn("semantic indexing failed; keyword search still works", err);
    } finally {
      this.indexing = false;
    }
    return n;
  }

  private ownerText(type: "note" | "meeting" | "dictation", id: string): string {
    if (type === "note") {
      const n = this.d.notes.get(id);
      return n ? `${n.title}\n${n.bodyText}` : "";
    }
    if (type === "meeting") {
      const m = this.d.meetings.get(id);
      if (!m) return "";
      const speakers = Object.fromEntries(this.d.meetings.speakers(id).map((s) => [s.key, { name: s.name }]));
      return `${m.title}\n${transcriptForLlm({ lines: this.d.meetings.lines(id), speakers })}`;
    }
    return this.d.store.getDictation(id)?.cleanText ?? "";
  }

  async search(q: string, opts: { semantic?: boolean; limit?: number } = {}): Promise<SearchHit[]> {
    const query = q.trim();
    if (!query) return [];
    const limit = opts.limit ?? 30;
    const keyword = this.keywordSearch(query, 50);
    let semantic: SearchHit[] = [];
    if (opts.semantic !== false && this.semanticAvailable) {
      try {
        semantic = await this.semanticSearch(query, 50);
      } catch (err) {
        log.warn("semantic search failed, keyword only", err);
      }
    }
    return rrf(
      [
        { items: keyword, via: "keyword" },
        { items: semantic, via: "semantic" },
      ],
      (h) => `${h.kind}:${h.id}`,
    )
      .slice(0, limit)
      .map(({ item, score, via }) => ({ ...item, score, via }));
  }

  private keywordSearch(q: string, limit: number): SearchHit[] {
    const fts = toFtsQuery(q).replace(/" "/g, '" OR "');
    const db = this.d.store.db;
    const notes = db
      .prepare(
        `SELECT n.id, n.title, snippet(notes_fts, 1, '', '', '…', 16) snip, n.updated_at date
         FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ? AND n.deleted_at IS NULL ORDER BY rank LIMIT ?`,
      )
      .all(fts, limit) as Array<{ id: string; title: string; snip: string; date: number }>;
    const lines = db
      .prepare(
        `SELECT m.id, m.title, l.text snip, l.start_ms at, m.started_at date
         FROM meeting_lines_fts f JOIN meeting_lines l ON l.rowid = f.rowid JOIN meetings m ON m.id = l.meeting_id
         WHERE meeting_lines_fts MATCH ? AND m.deleted_at IS NULL ORDER BY rank LIMIT ?`,
      )
      .all(fts, limit) as Array<{ id: string; title: string; snip: string; at: number; date: number }>;
    const dictations = db
      .prepare(
        `SELECT d.id, d.clean_text snip, d.created_at date FROM dictations_fts f JOIN dictations d ON d.rowid = f.rowid
         WHERE dictations_fts MATCH ? AND d.deleted_at IS NULL ORDER BY rank LIMIT ?`,
      )
      .all(fts, limit) as Array<{ id: string; snip: string; date: number }>;
    const seenMeeting = new Set<string>();
    const hits: SearchHit[] = [];
    for (const n of notes) hits.push({ kind: "note", id: n.id, title: n.title, snippet: n.snip, date: n.date, score: 0, via: "keyword" });
    for (const l of lines) {
      if (seenMeeting.has(l.id)) continue; // best line per meeting
      seenMeeting.add(l.id);
      hits.push({ kind: "meeting", id: l.id, title: l.title, snippet: l.snip, at: l.at, date: l.date, score: 0, via: "keyword" });
    }
    for (const d of dictations) hits.push({ kind: "dictation", id: d.id, title: "Dictation", snippet: d.snip, date: d.date, score: 0, via: "keyword" });
    return hits;
  }

  private async semanticSearch(q: string, limit: number): Promise<SearchHit[]> {
    const [qv] = await this.embed([QUERY_PREFIX + q]);
    const all = this.d.notes.allEmbeddings(MODEL);
    const best = topK(qv!, all.map((e, i) => ({ id: String(i), v: e.v })), limit * 3, MIN_SCORE);
    const out: SearchHit[] = [];
    const seen = new Set<string>();
    for (const b of best) {
      const e = all[Number(b.id)]!;
      const key = `${e.ownerType}:${e.ownerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = this.describe(e.ownerType as SearchHit["kind"], e.ownerId, e.text, b.score);
      if (hit) out.push(hit);
      if (out.length >= limit) break;
    }
    return out;
  }

  private describe(kind: SearchHit["kind"], id: string, text: string, score: number): SearchHit | null {
    const snippet = text.length > 220 ? `${text.slice(0, 220)}…` : text;
    if (kind === "note") {
      const n = this.d.notes.get(id);
      return n ? { kind, id, title: n.title, snippet, date: n.updatedAt, score, via: "semantic" } : null;
    }
    if (kind === "meeting") {
      const m = this.d.meetings.get(id);
      return m ? { kind, id, title: m.title, snippet, date: m.startedAt, score, via: "semantic" } : null;
    }
    const d = this.d.store.getDictation(id);
    return d ? { kind, id, title: "Dictation", snippet, date: d.createdAt, score, via: "semantic" } : null;
  }

  /** Relevant meeting excerpts for cross-meeting questions. */
  async meetingContext(question: string, maxChars = 24000): Promise<string> {
    const hits = (await this.search(question, { limit: 12 })).filter((h) => h.kind === "meeting");
    const parts: string[] = [];
    let used = 0;
    for (const h of hits) {
      const m = this.d.meetings.get(h.id);
      if (!m) continue;
      const speakers = Object.fromEntries(this.d.meetings.speakers(h.id).map((s) => [s.key, { name: s.name }]));
      const lines = this.d.meetings.lines(h.id);
      // A window of transcript around the matching moment, plus the summary if there is one.
      const center = h.at ?? 0;
      const window = lines.filter((l) => Math.abs(l.start - center) < 180000);
      const body = transcriptForLlm({ lines: window.length ? window : lines.slice(0, 80), speakers });
      const summary = m.summary ? `Summary: ${[...m.summary.keyPoints, ...m.summary.decisions].join(" ")}\n` : "";
      const part = `### ${m.title} (${new Date(m.startedAt).toLocaleDateString()})\n${summary}${body}`;
      if (used + part.length > maxChars) break;
      parts.push(part);
      used += part.length;
    }
    return parts.join("\n\n");
  }
}
