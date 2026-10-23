export interface FolderRecord {
  id: string;
  name: string;
  parentId: string | null;
}

export interface NoteRecord {
  id: string;
  folderId: string | null;
  title: string;
  /** TipTap/ProseMirror document JSON. */
  bodyJson: string;
  bodyText: string;
  sourceType: "meeting" | "dictation" | null;
  sourceId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type SearchKind = "note" | "meeting" | "dictation";

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  snippet: string;
  /** Milliseconds into a meeting, for meeting hits. */
  at?: number;
  date: number;
  score: number;
  via: "keyword" | "semantic" | "both";
}

/** Split text into overlapping chunks of roughly `size` characters on sentence boundaries. */
export function chunkText(text: string, size = 800, overlap = 120): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [clean];
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > size) {
      chunks.push(cur.trim());
      cur = cur.slice(Math.max(0, cur.length - overlap)) + s;
    } else cur += s;
    // A single sentence longer than the chunk size is cut hard.
    while (cur.length > size * 1.5) {
      chunks.push(cur.slice(0, size).trim());
      cur = cur.slice(size - overlap);
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

/**
 * Reciprocal Rank Fusion: combine ranked lists (keyword and semantic) without having to make
 * their scores comparable. k = 60 is the standard constant.
 */
export function rrf<T>(lists: Array<{ items: T[]; via: "keyword" | "semantic" }>, key: (t: T) => string, k = 60): Array<{ item: T; score: number; via: "keyword" | "semantic" | "both" }> {
  const acc = new Map<string, { item: T; score: number; via: Set<string> }>();
  for (const list of lists) {
    list.items.forEach((item, rank) => {
      const id = key(item);
      const e = acc.get(id) ?? { item, score: 0, via: new Set<string>() };
      e.score += 1 / (k + rank + 1);
      e.via.add(list.via);
      acc.set(id, e);
    });
  }
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .map((e) => ({ item: e.item, score: e.score, via: e.via.size > 1 ? "both" : (([...e.via][0] ?? "keyword") as "keyword" | "semantic") }));
}

export function topK(query: Float32Array, vectors: Array<{ id: string; v: Float32Array }>, k: number, minScore = 0.3): Array<{ id: string; score: number }> {
  const qn = Math.hypot(...query);
  return vectors
    .map(({ id, v }) => {
      let dot = 0;
      let vn = 0;
      for (let i = 0; i < v.length; i++) {
        dot += v[i]! * query[i]!;
        vn += v[i]! * v[i]!;
      }
      return { id, score: qn && vn ? dot / (qn * Math.sqrt(vn)) : 0 };
    })
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
