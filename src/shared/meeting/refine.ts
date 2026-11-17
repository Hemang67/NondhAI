/**
 * Meeting-level re-clustering after sherpa-onnx diarization (docs/SPEAKER_ID_AUDIT.md, R1–R3).
 *
 * sherpa clusters window-level embeddings with complete linkage and keeps every cluster, so one
 * person comes back as several clusters and a single "yes" can become its own speaker. Here the
 * raw clusters are treated as fragments:
 *   1. planPieces: pick clean stretches of each fragment (no other cluster talking, edges
 *      trimmed, 1–6 s, spread over the meeting) to embed.
 *   2. recluster: merge fragments by average similarity of their pieces, never when they were
 *      heard talking at the same time; fragments with too little clear speech can't be a speaker
 *      on their own and are folded into the closest large one (flagged when the evidence is weak).
 * Nothing here uses adjacency in time as evidence that two fragments are the same person.
 */
import { cosine } from "./speakers";

export interface RawTurn {
  start: number;
  end: number;
  cluster: number;
}

export interface Piece {
  cluster: number;
  start: number;
  end: number;
  /** Too short to trust: the fragment's longest turn, used only when it has nothing better. */
  weak: boolean;
}

export interface EmbeddedPiece extends Piece {
  embedding: ArrayLike<number>;
}

export interface RefinedTurn extends RawTurn {
  /** The turn's speaker was a weak guess (folded in with little evidence). */
  uncertain?: boolean;
}

export interface RefinedCluster {
  cluster: number;
  /** Duration-weighted mean of the cluster's piece embeddings, L2-normalised. */
  embedding: number[] | null;
  /** Speech that went into the embedding (ms). */
  cleanMs: number;
  /** Mean similarity of the pieces to the centroid: low means a mixed or noisy cluster. */
  cohesion: number;
  firstStart: number;
  totalMs: number;
}

export interface PieceOptions {
  minMs?: number;
  maxMs?: number;
  trimMs?: number;
  capMsPerCluster?: number;
  weakMinMs?: number;
}

export function planPieces(turns: RawTurn[], o: PieceOptions = {}): Piece[] {
  const minMs = o.minMs ?? 1000;
  const maxMs = o.maxMs ?? 6000;
  const trim = o.trimMs ?? 100;
  const cap = o.capMsPerCluster ?? 60000;
  const weakMin = o.weakMinMs ?? 300;
  const byCluster = new Map<number, Piece[]>();
  for (const t of turns) {
    // Clean = this turn minus every other cluster's turns (widened by the trim), edges trimmed.
    let parts: Array<[number, number]> = [[t.start + trim, t.end - trim]];
    for (const u of turns) {
      if (u.cluster === t.cluster || u.end + trim <= t.start || u.start - trim >= t.end) continue;
      parts = parts.flatMap(([a, b]): Array<[number, number]> => {
        const [s, e] = [u.start - trim, u.end + trim];
        if (e <= a || s >= b) return [[a, b]];
        const out: Array<[number, number]> = [
          [a, Math.min(b, s)],
          [Math.max(a, e), b],
        ];
        return out.filter(([x, y]) => y > x);
      });
    }
    for (const [a, b] of parts) {
      const len = b - a;
      if (len < minMs) continue;
      const n = Math.ceil(len / maxMs);
      const list = byCluster.get(t.cluster) ?? [];
      for (let k = 0; k < n; k++) list.push({ cluster: t.cluster, start: Math.round(a + (len * k) / n), end: Math.round(a + (len * (k + 1)) / n), weak: false });
      byCluster.set(t.cluster, list);
    }
  }
  const out: Piece[] = [];
  for (const [cluster, list] of byCluster) {
    list.sort((x, y) => x.start - y.start);
    const total = list.reduce((n, p) => n + p.end - p.start, 0);
    if (total <= cap) {
      out.push(...list);
      continue;
    }
    // Evenly spaced over the meeting, so the profile isn't just the first few minutes.
    const m = Math.max(1, Math.floor(cap / (total / list.length)));
    let picked = Array.from({ length: m }, (_, j) => list[Math.floor((j * list.length) / m)]!);
    while (picked.length > 1 && picked.reduce((n, p) => n + p.end - p.start, 0) > cap) picked = picked.slice(0, -1);
    out.push(...picked);
  }
  // Fragments with no clean piece get their longest turn as a weak piece.
  for (const cluster of new Set(turns.map((t) => t.cluster))) {
    if (byCluster.has(cluster)) continue;
    const longest = turns.filter((t) => t.cluster === cluster).sort((a, b) => b.end - b.start - (a.end - a.start))[0]!;
    if (longest.end - longest.start >= weakMin) out.push({ cluster, start: longest.start, end: longest.end, weak: true });
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface ReclusterOptions {
  /** Average piece similarity at or above which two fragments are the same person. */
  mergeThreshold?: number;
  /** Clear speech a fragment needs to stand as a speaker on its own (ms). */
  minClusterMs?: number;
  /** One stretch of simultaneous speech this long proves two fragments are different people (ms). */
  cannotLinkMs?: number;
  /** A folded fragment below this similarity, or this close to a runner-up, is flagged. */
  reassignThreshold?: number;
  reassignMargin?: number;
}

const unit = (v: ArrayLike<number>): number[] => {
  const n = Math.hypot(...Array.from(v)) || 1;
  return Array.from(v, (x) => x / n);
};

/**
 * The longest single stretch in which two sets of turns talk at once. Brief overlaps where one
 * person's fragments meet are segmentation artifacts; only sustained simultaneous speech proves
 * two different people, so stretches are not added up.
 */
export function longestOverlapMs(a: Array<{ start: number; end: number }>, b: Array<{ start: number; end: number }>): number {
  let ms = 0;
  for (const x of a) for (const y of b) ms = Math.max(ms, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  return ms;
}

const meanSim = (a: number[][], b: number[][]) => {
  let s = 0;
  for (const x of a) for (const y of b) s += cosine(x, y);
  return s / (a.length * b.length);
};

export function recluster(turns: RawTurn[], pieces: EmbeddedPiece[], o: ReclusterOptions = {}): { turns: RefinedTurn[]; clusters: RefinedCluster[] } {
  const mergeAt = o.mergeThreshold ?? 0.4;
  const minClusterMs = o.minClusterMs ?? 4000;
  const cannotLink = o.cannotLinkMs ?? 5000;
  const reassignAt = o.reassignThreshold ?? 0.5;
  const margin = o.reassignMargin ?? 0.05;

  interface Frag {
    id: number;
    turns: RawTurn[];
    strong: EmbeddedPiece[];
    weak: EmbeddedPiece[];
    cleanMs: number;
  }
  const frags = new Map<number, Frag>();
  for (const t of turns) {
    if (!frags.has(t.cluster)) frags.set(t.cluster, { id: t.cluster, turns: [], strong: [], weak: [], cleanMs: 0 });
    frags.get(t.cluster)!.turns.push(t);
  }
  for (const p of pieces) {
    const f = frags.get(p.cluster);
    if (!f) continue;
    if (p.weak) f.weak.push(p);
    else {
      f.strong.push(p);
      f.cleanMs += p.end - p.start;
    }
  }
  const embs = (f: Frag) => (f.strong.length ? f.strong : f.weak).map((p) => unit(p.embedding));

  // Which fragments can stand on their own.
  let large = [...frags.values()].filter((f) => f.cleanMs >= minClusterMs);
  if (!large.length) large = [...frags.values()].filter((f) => f.strong.length);
  if (!large.length) large = [...frags.values()].filter((f) => f.weak.length);

  // Average-linkage agglomeration over the large fragments, with cannot-link. Pairwise sums of
  // piece similarities and the longest simultaneous stretch are computed once and combined on
  // each merge (average linkage = sum / (n_i·n_j)), so long meetings stay cheap.
  const groups = large.map((f) => ({ frags: [f], embs: embs(f), turns: [...f.turns] }));
  const n = groups.length;
  const simSum = groups.map((a) => groups.map((b) => (a === b ? 0 : meanSim(a.embs, b.embs) * a.embs.length * b.embs.length)));
  const together = groups.map((a) => groups.map((b) => (a === b ? 0 : longestOverlapMs(a.turns, b.turns))));
  const alive = new Array<boolean>(n).fill(true);
  for (;;) {
    let best: [number, number] | null = null;
    let bestSim = mergeAt;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j] || together[i]![j]! >= cannotLink) continue;
        const s = simSum[i]![j]! / (groups[i]!.embs.length * groups[j]!.embs.length);
        if (s >= bestSim) [best, bestSim] = [[i, j], s];
      }
    }
    if (!best) break;
    const [i, j] = best;
    for (let k = 0; k < n; k++) {
      simSum[i]![k]! += simSum[j]![k]!;
      simSum[k]![i] = simSum[i]![k]!;
      together[i]![k] = Math.max(together[i]![k]!, together[j]![k]!);
      together[k]![i] = together[i]![k]!;
    }
    groups[i] = { frags: [...groups[i]!.frags, ...groups[j]!.frags], embs: [...groups[i]!.embs, ...groups[j]!.embs], turns: [...groups[i]!.turns, ...groups[j]!.turns] };
    alive[j] = false;
  }
  for (let k = n - 1; k >= 0; k--) if (!alive[k]) groups.splice(k, 1);

  // Fold the small fragments in.
  const groupOf = new Map<number, number>();
  groups.forEach((g, gi) => g.frags.forEach((f) => groupOf.set(f.id, gi)));
  const uncertainFrag = new Set<number>();
  const foldedStrong = new Map<number, EmbeddedPiece[]>();
  for (const f of frags.values()) {
    if (groupOf.has(f.id)) continue;
    const e = embs(f);
    if (!e.length || !groups.length) continue;
    const scored = groups
      .map((g, gi) => ({ gi, s: longestOverlapMs(f.turns, g.turns) >= cannotLink ? -Infinity : meanSim(e, g.embs) }))
      .sort((a, b) => b.s - a.s);
    if (scored[0]!.s === -Infinity) continue;
    groupOf.set(f.id, scored[0]!.gi);
    const second = scored[1]?.s ?? -1;
    if (!f.strong.length || scored[0]!.s < reassignAt || scored[0]!.s - second < margin) uncertainFrag.add(f.id);
    else foldedStrong.set(scored[0]!.gi, [...(foldedStrong.get(scored[0]!.gi) ?? []), ...f.strong]);
  }

  // Nothing could be embedded at all: keep sherpa's fragments, renumbered.
  if (!groups.length) for (const f of frags.values()) groupOf.set(f.id, groupOf.size);

  // Number the final speakers by first appearance.
  const firstOf = new Map<number, number>();
  for (const t of turns) {
    const g = groupOf.get(t.cluster);
    if (g !== undefined && !(firstOf.get(g)! <= t.start)) firstOf.set(g, t.start);
  }
  const order = [...firstOf].sort((a, b) => a[1] - b[1]).map(([g]) => g);
  const label = new Map(order.map((g, i) => [g, i]));

  const outTurns: RefinedTurn[] = turns
    .filter((t) => groupOf.has(t.cluster))
    .map((t) => ({ ...t, cluster: label.get(groupOf.get(t.cluster)!)!, ...(uncertainFrag.has(t.cluster) ? { uncertain: true } : {}) }));

  const clusters: RefinedCluster[] = order.map((g, i) => {
    const members = [...frags.values()].filter((f) => groupOf.get(f.id) === g);
    const strong = [...(groups[g]?.frags.flatMap((f) => f.strong) ?? []), ...(foldedStrong.get(g) ?? [])];
    const voice = describeVoice(strong.length ? strong : members.flatMap((f) => f.weak));
    const ts = outTurns.filter((t) => t.cluster === i);
    return {
      cluster: i,
      embedding: voice?.embedding ?? null,
      cleanMs: strong.reduce((n, p) => n + p.end - p.start, 0),
      cohesion: voice?.cohesion ?? 0,
      firstStart: Math.min(...ts.map((t) => t.start)),
      totalMs: ts.reduce((n, t) => n + t.end - t.start, 0),
    };
  });
  return { turns: outTurns, clusters };
}

/**
 * One voice from embedded pieces: the duration-weighted mean of the L2-normalised embeddings,
 * the clear speech behind it, and how consistent the pieces are (mean similarity to the result).
 */
export function describeVoice(pieces: EmbeddedPiece[]): { embedding: number[]; cleanMs: number; cohesion: number } | null {
  if (!pieces.length) return null;
  const dim = pieces[0]!.embedding.length;
  const acc = new Array<number>(dim).fill(0);
  for (const p of pieces) {
    const v = unit(p.embedding);
    for (let k = 0; k < dim; k++) acc[k]! += v[k]! * (p.end - p.start);
  }
  const embedding = unit(acc);
  return {
    embedding,
    cleanMs: pieces.reduce((n, p) => n + p.end - p.start, 0),
    cohesion: pieces.reduce((n, p) => n + cosine(unit(p.embedding), embedding), 0) / pieces.length,
  };
}

/**
 * Pieces to embed for one speaker of a finished transcript (used to re-derive a named person's
 * voice with a new model): their lines, minus any time another speaker's line overlaps.
 */
export function piecesForSpeaker(lines: Array<{ start: number; end: number; speakerKey: string }>, key: string, o: PieceOptions = {}): Piece[] {
  const turns = lines.map((l) => ({ start: l.start, end: l.end, cluster: l.speakerKey === key ? 0 : 1 }));
  return planPieces(turns, o).filter((p) => p.cluster === 0 && !p.weak);
}
