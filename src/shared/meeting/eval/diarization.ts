/**
 * Diarization scoring for the speaker-identification evaluation (docs/SPEAKER_ID_AUDIT.md).
 * Times are ms. Scoring is frame-based (10 ms by default), md-eval style: overlapped reference
 * speech counts once per speaker, hypothesis speakers are mapped one-to-one onto reference
 * speakers to maximise agreement, and a collar around every reference boundary is not scored.
 */

export interface LabeledTurn {
  speaker: string;
  start: number;
  end: number;
}

export function parseRttm(text: string): Map<string, LabeledTurn[]> {
  const out = new Map<string, LabeledTurn[]>();
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== "SPEAKER" || f.length < 8) continue;
    const start = Math.round(Number(f[3]) * 1000);
    const end = start + Math.round(Number(f[4]) * 1000);
    if (!Number.isFinite(start) || !(end > start)) continue;
    if (!out.has(f[1]!)) out.set(f[1]!, []);
    out.get(f[1]!)!.push({ speaker: f[7]!, start, end });
  }
  return out;
}

export function toRttm(fileId: string, turns: LabeledTurn[]): string {
  // RTTM fields are whitespace-separated, so names with spaces are joined with underscores.
  const id = (s: string) => s.replace(/\s+/g, "_");
  return turns
    .map((t) => `SPEAKER ${id(fileId)} 1 ${(t.start / 1000).toFixed(3)} ${((t.end - t.start) / 1000).toFixed(3)} <NA> <NA> ${id(t.speaker)} <NA> <NA>`)
    .join("\n")
    .concat(turns.length ? "\n" : "");
}

/** Undo toRttm's space replacement when comparing names. */
const norm = (s: string) => s.replace(/\s+/g, "_");

export interface DiarizationScore {
  /** Reference speaker-time in the scored region (overlap counts once per speaker). */
  scoredMs: number;
  missMs: number;
  falseAlarmMs: number;
  confusionMs: number;
  /** (miss + false alarm + confusion) / scored. */
  der: number;
  refSpeakers: number;
  hypSpeakers: number;
  /** Hypothesis speaker → reference speaker it was mapped to. */
  mapping: Map<string, string>;
  /** Hypothesis speaker → the reference speaker it overlaps most (share of its scored time). */
  dominant: Map<string, { speaker: string; ms: number; share: number }>;
  /** Reference speakers whose speech is spread over more than one hypothesis speaker (each ≥ 10 %). */
  splitSpeakers: number;
  /** Hypothesis speakers holding ≥ 10 % of more than one reference speaker's speech. */
  mergedSpeakers: number;
  /** How much of each hypothesis speaker is its dominant reference speaker (time-weighted). */
  purity: number;
  /** How much of each reference speaker sits in its dominant hypothesis speaker (time-weighted). */
  coverage: number;
}

function activity(turns: LabeledTurn[], frames: number, frameMs: number): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const t of turns) {
    const key = norm(t.speaker);
    if (!out.has(key)) out.set(key, new Uint8Array(frames));
    const a = out.get(key)!;
    const from = Math.max(0, Math.round(t.start / frameMs));
    const to = Math.min(frames, Math.round(t.end / frameMs));
    for (let i = from; i < to; i++) a[i] = 1;
  }
  return out;
}

export function scoreDiarization(ref: LabeledTurn[], hyp: LabeledTurn[], opts: { collarMs?: number; frameMs?: number } = {}): DiarizationScore {
  const frameMs = opts.frameMs ?? 10;
  const collar = Math.round((opts.collarMs ?? 250) / frameMs);
  const frames = Math.ceil(Math.max(0, ...ref.map((t) => t.end), ...hyp.map((t) => t.end)) / frameMs);
  const R = activity(ref, frames, frameMs);
  const H = activity(hyp, frames, frameMs);
  const refIds = [...R.keys()];
  const hypIds = [...H.keys()];

  const scored = new Uint8Array(frames).fill(1);
  if (collar > 0) {
    for (const t of ref) {
      for (const b of [Math.round(t.start / frameMs), Math.round(t.end / frameMs)]) {
        for (let i = Math.max(0, b - collar); i < Math.min(frames, b + collar); i++) scored[i] = 0;
      }
    }
  }

  // Co-occurrence of each hypothesis and reference speaker over scored frames.
  const co = hypIds.map(() => refIds.map(() => 0));
  const refTotal = refIds.map(() => 0);
  const hypTotal = hypIds.map(() => 0);
  for (let i = 0; i < frames; i++) {
    if (!scored[i]) continue;
    for (let r = 0; r < refIds.length; r++) if (R.get(refIds[r]!)![i]) refTotal[r]!++;
    for (let h = 0; h < hypIds.length; h++) {
      if (!H.get(hypIds[h]!)![i]) continue;
      hypTotal[h]!++;
      for (let r = 0; r < refIds.length; r++) if (R.get(refIds[r]!)![i]) co[h]![r]!++;
    }
  }

  const assign = assignMax(co);
  const mapping = new Map<string, string>();
  assign.forEach((r, h) => r >= 0 && co[h]![r]! > 0 && mapping.set(hypIds[h]!, refIds[r]!));

  let scoredMs = 0;
  let miss = 0;
  let fa = 0;
  let conf = 0;
  for (let i = 0; i < frames; i++) {
    if (!scored[i]) continue;
    let nRef = 0;
    let nHyp = 0;
    let correct = 0;
    for (const id of refIds) nRef += R.get(id)![i]!;
    for (const id of hypIds) {
      if (!H.get(id)![i]) continue;
      nHyp++;
      const m = mapping.get(id);
      if (m !== undefined && R.get(m)![i]) correct++;
    }
    scoredMs += nRef;
    miss += Math.max(0, nRef - nHyp);
    fa += Math.max(0, nHyp - nRef);
    conf += Math.min(nRef, nHyp) - correct;
  }

  const dominant = new Map<string, { speaker: string; ms: number; share: number }>();
  hypIds.forEach((id, h) => {
    const best = co[h]!.reduce((b, x, r) => (x > co[h]![b]! ? r : b), 0);
    if (co[h]![best]! > 0) dominant.set(id, { speaker: refIds[best]!, ms: co[h]![best]! * frameMs, share: co[h]![best]! / hypTotal[h]! });
  });

  const share = 0.1;
  const splitSpeakers = refIds.filter((_, r) => refTotal[r]! > 0 && hypIds.filter((_, h) => co[h]![r]! >= share * refTotal[r]!).length > 1).length;
  const mergedSpeakers = hypIds.filter((_, h) => refIds.filter((_, r) => refTotal[r]! > 0 && co[h]![r]! >= share * refTotal[r]!).length > 1).length;
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const purityNum = sum(co.map((row) => Math.max(0, ...row)));
  const coverageNum = sum(refIds.map((_, r) => Math.max(0, ...co.map((row) => row[r]!))));

  return {
    scoredMs: scoredMs * frameMs,
    missMs: miss * frameMs,
    falseAlarmMs: fa * frameMs,
    confusionMs: conf * frameMs,
    der: scoredMs ? (miss + fa + conf) / scoredMs : 0,
    refSpeakers: refIds.length,
    hypSpeakers: hypIds.length,
    mapping,
    dominant,
    splitSpeakers,
    mergedSpeakers,
    purity: sum(hypTotal) ? purityNum / sum(hypTotal) : 1,
    coverage: sum(refTotal) ? coverageNum / sum(refTotal) : 1,
  };
}

/**
 * One-to-one assignment of rows to columns maximising the summed weight (Hungarian method on
 * the padded square cost matrix). Returns the column for each row, or -1.
 */
export function assignMax(w: number[][]): number[] {
  const rows = w.length;
  const cols = rows ? w[0]!.length : 0;
  const n = Math.max(rows, cols);
  if (!n) return [];
  let max = 0;
  for (const row of w) for (const x of row) max = Math.max(max, x);
  // cost[i][j] for the 1-indexed classic implementation.
  const cost = (i: number, j: number) => (i <= rows && j <= cols ? max - w[i - 1]![j - 1]! : max);
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost(i0, j) - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else minv[j]! -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0);
  }
  const out = new Array<number>(rows).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j]! >= 1 && p[j]! <= rows && j <= cols) out[p[j]! - 1] = j - 1;
  return out;
}
