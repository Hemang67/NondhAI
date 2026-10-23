import type { ConfidenceLevel, Segment, SpeakerLabel, TranscriptLine, Turn } from "./types";

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function meanVector(vectors: ArrayLike<number>[]): Float32Array {
  const dim = vectors[0]?.length ?? 0;
  const out = new Float32Array(dim);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i]! += v[i]! / vectors.length;
  return out;
}

export interface KnownVoice {
  personId: string;
  name: string;
  embeddings: ArrayLike<number>[];
}

export interface VoiceMatch {
  personId: string;
  name: string;
  score: number;
  confidence: ConfidenceLevel;
}

/**
 * Thresholds for CAM++ (3D-Speaker) embeddings, cosine similarity. Same-speaker pairs sit well
 * above 0.6 on clean speech; meeting audio is noisier, so a "high" match also needs a clear
 * margin over the runner-up.
 */
export const MATCH = { accept: 0.55, strong: 0.7, margin: 0.08 };

export function matchVoice(embedding: ArrayLike<number>, known: KnownVoice[], exclude: Set<string> = new Set()): VoiceMatch | null {
  const scored = known
    .filter((k) => !exclude.has(k.personId) && k.embeddings.length)
    .map((k) => ({ k, score: Math.max(...k.embeddings.map((e) => cosine(embedding, e))) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < MATCH.accept) return null;
  const margin = best.score - (scored[1]?.score ?? 0);
  const confidence: ConfidenceLevel = best.score >= MATCH.strong && margin >= MATCH.margin ? "high" : "medium";
  return { personId: best.k.personId, name: best.k.name, score: best.score, confidence };
}

/**
 * Name the diarization clusters. Each cluster gets the best voice match that is still free
 * (one person can't be two clusters); the rest become "Speaker 1", "Speaker 2"... in order of
 * first appearance.
 */
export function labelClusters(
  clusters: Array<{ cluster: number; embedding: ArrayLike<number> | null; firstStart: number }>,
  known: KnownVoice[],
  opts: { keyPrefix?: string; exclude?: Set<string> } = {},
): Map<number, SpeakerLabel> {
  const prefix = opts.keyPrefix ?? "c";
  const used = new Set(opts.exclude ?? []);
  const result = new Map<number, SpeakerLabel>();
  // Strongest matches claim people first.
  const candidates = clusters
    .map((c) => ({ c, m: c.embedding ? matchVoice(c.embedding, known, used) : null }))
    .sort((a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0));
  for (const { c } of candidates) {
    const m = c.embedding ? matchVoice(c.embedding, known, used) : null;
    if (m) {
      used.add(m.personId);
      result.set(c.cluster, { key: `${prefix}${c.cluster}`, name: m.name, personId: m.personId, score: m.score, confidence: m.confidence });
    }
  }
  let n = 1;
  for (const c of [...clusters].sort((a, b) => a.firstStart - b.firstStart)) {
    if (result.has(c.cluster)) continue;
    result.set(c.cluster, { key: `${prefix}${c.cluster}`, name: `Speaker ${n++}`, personId: null, score: null, confidence: "low" });
  }
  return result;
}

/** Which cluster was talking at time t, if any; nearest turn within `slackMs` otherwise. */
function clusterAt(turns: Turn[], t: number, slackMs: number): { cluster: number | null; competing: boolean } {
  const active = turns.filter((x) => x.start <= t && t <= x.end);
  if (active.length) {
    const clusters = new Set(active.map((a) => a.cluster));
    return { cluster: active[0]!.cluster, competing: clusters.size > 1 };
  }
  let best: Turn | null = null;
  let dist = Infinity;
  for (const x of turns) {
    const d = t < x.start ? x.start - t : t - x.end;
    if (d < dist) {
      dist = d;
      best = x;
    }
  }
  return dist <= slackMs && best ? { cluster: best.cluster, competing: false } : { cluster: null, competing: false };
}

/**
 * Split recognized segments into transcript lines by speaker. Words are assigned to the
 * diarization turn they fall in, so a segment where the speaker changes becomes two lines.
 * `fixedKey` labels every word (the mic channel in a call is always "me").
 */
export function linesFromSegments(
  segments: Segment[],
  opts: { turns?: Turn[]; fixedKey?: string; keyFor?: (cluster: number) => string; slackMs?: number },
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const slack = opts.slackMs ?? 600;
  for (const seg of segments) {
    let cur: TranscriptLine | null = null;
    let words: string[] = [];
    const flush = () => {
      if (cur && words.length) {
        cur.text = words.join(" ");
        lines.push(cur);
      }
      cur = null;
      words = [];
    };
    for (const w of seg.words) {
      let key: string;
      let uncertain = false;
      let competing = false;
      if (opts.fixedKey) key = opts.fixedKey;
      else {
        const at = clusterAt(opts.turns ?? [], (w.start + w.end) / 2, slack);
        competing = at.competing;
        if (at.cluster === null) {
          uncertain = true;
          key = (cur as TranscriptLine | null)?.speakerKey ?? "unknown";
        } else key = opts.keyFor ? opts.keyFor(at.cluster) : `c${at.cluster}`;
      }
      if (!cur || (cur as TranscriptLine).speakerKey !== key) {
        flush();
        cur = {
          id: `${seg.id}-${lines.length}`,
          start: w.start,
          end: w.end,
          speakerKey: key,
          channel: seg.channel,
          text: "",
          conf: seg.conf,
          overlap: false,
          uncertainSpeaker: false,
        };
      }
      const c = cur as TranscriptLine;
      c.end = w.end;
      c.uncertainSpeaker ||= uncertain;
      c.overlap ||= competing;
      words.push(w.w);
    }
    flush();
  }
  return lines;
}

/** Merge per-channel lines into one timeline and mark lines where two speakers overlap. */
export function mergeLines(...groups: TranscriptLine[][]): TranscriptLine[] {
  const all = groups.flat().sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length && all[j]!.start < all[i]!.end; j++) {
      const a = all[i]!;
      const b = all[j]!;
      if (a.speakerKey === b.speakerKey) continue;
      const ov = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      // Count it as overlap only when it is more than a quick back-channel ("mm-hm").
      if (ov > 400) {
        a.overlap = true;
        b.overlap = true;
      }
    }
  }
  return all;
}
