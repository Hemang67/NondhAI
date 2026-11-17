import type { Segment, SpeakerLabel, TranscriptLine, Turn } from "./types";

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

export interface KnownVoice {
  personId: string;
  name: string;
  embeddings: ArrayLike<number>[];
  /** Per-sample quality 0..1 (same order as embeddings); missing = 0.5 (samples saved before quality existed). */
  qualities?: number[];
}

/**
 * Recognition settings for one embedding model, calibrated on the speaker evaluation set
 * (docs/SPEAKER_ID_AUDIT.md). Clusters are bucketed by how much clear speech their embedding
 * rests on: less speech, noisier embedding, higher bar.
 */
export interface MatchPolicy {
  /** Upper bounds (ms of clear speech) of all buckets but the last. */
  buckets: number[];
  /** Score needed to name a cluster, per bucket. */
  accept: number[];
  /** Score for "high" confidence, per bucket. */
  strong: number[];
  /** Required lead over the next most similar person. */
  margin: number;
  /** Below this much clear speech a cluster is never named. */
  minSpeechMs: number;
  /** Best samples averaged per person. */
  topK: number;
}

/**
 * When a meeting speaker's voice is worth remembering (TitaNet-small; re-check if the model
 * changes). From the speaker evaluation: single-voice clusters had cohesion 0.74–0.95 (median
 * 0.84); most mixed clusters had under 10 s of clear speech, which the speech minimum excludes.
 */
export const VOICE_SAVE = { minSpeechMs: 10000, fullSpeechMs: 60000, minCohesion: 0.7, goodCohesion: 0.85 };

/**
 * 0..1 quality of a speaker's voice embedding, from the clear speech behind it and how consistent
 * that speech is. Zero means "don't save it": too little speech, or probably two people.
 */
export function voiceQuality(cleanMs: number, cohesion: number): number {
  const s = VOICE_SAVE;
  if (cleanMs < s.minSpeechMs || cohesion < s.minCohesion) return 0;
  const speech = Math.min(1, cleanMs / s.fullSpeechMs);
  const voice = Math.min(1, (cohesion - s.minCohesion) / (s.goodCohesion - s.minCohesion));
  return Math.max(0.05, 0.5 * speech + 0.5 * voice);
}

/**
 * What to remember when the user names a meeting speaker: the voice and its quality, or null
 * when it shouldn't be saved (embedded by another model, or too little / too mixed speech).
 */
export function voiceprintToSave(
  sp: { embedding: ArrayLike<number> | null; cleanMs: number | null; cohesion: number | null; model: string | null },
  currentModel: string,
): { embedding: ArrayLike<number>; quality: number; speechMs: number } | null {
  if (!sp.embedding || sp.model !== currentModel) return null;
  const quality = voiceQuality(sp.cleanMs ?? 0, sp.cohesion ?? 0);
  return quality > 0 ? { embedding: sp.embedding, quality, speechMs: sp.cleanMs ?? 0 } : null;
}

/**
 * How similar a voice is to a person: the quality-weighted mean of their `k` most similar samples.
 * Unlike the single best sample, this doesn't rise just because someone has many samples.
 */
export function profileScore(embedding: ArrayLike<number>, voice: KnownVoice, k: number): number {
  const sims = voice.embeddings.map((e, i) => ({ s: cosine(embedding, e), w: voice.qualities?.[i] ?? 0.5 })).sort((a, b) => b.s - a.s).slice(0, Math.max(1, k));
  const w = sims.reduce((n, x) => n + x.w, 0);
  return w > 0 ? sims.reduce((n, x) => n + x.s * x.w, 0) / w : sims.reduce((n, x) => n + x.s, 0) / sims.length;
}

const bucketOf = (p: MatchPolicy, cleanMs: number) => {
  const i = p.buckets.findIndex((b) => cleanMs < b);
  return i < 0 ? p.buckets.length : i;
};

/**
 * Name clusters after known people. A cluster is named only with enough clear speech, a score
 * past its bucket's threshold, and a clear lead over the runner-up; otherwise it stays unknown.
 * One person never gets two clusters: if several match the same person, the strongest keeps the
 * name and the others are merged into it, unless they talked at the same time (`cannotLink`), in
 * which case they stay unknown. A fragment is never handed to the next most similar person.
 */
export function identify(
  clusters: Array<{ cluster: number; embedding: ArrayLike<number> | null; cleanMs: number; firstStart: number }>,
  known: KnownVoice[],
  policy: MatchPolicy,
  cannotLink: (a: number, b: number) => boolean = () => false,
  opts: { keyPrefix?: string } = {},
): { labels: Map<number, SpeakerLabel & { margin: number | null }>; merges: Array<{ from: number; into: number }> } {
  const prefix = opts.keyPrefix ?? "c";
  const best = new Map<number, { person: KnownVoice; score: number; margin: number; bucket: number }>();
  const unknownScore = new Map<number, { score: number; margin: number } | null>();
  for (const c of clusters) {
    if (!c.embedding || c.cleanMs < policy.minSpeechMs || !known.length) {
      unknownScore.set(c.cluster, null);
      continue;
    }
    const scored = known.map((k) => ({ k, s: profileScore(c.embedding!, k, policy.topK) })).sort((a, b) => b.s - a.s);
    const top = scored[0]!;
    const margin = top.s - (scored[1]?.s ?? 0);
    const bucket = bucketOf(policy, c.cleanMs);
    if (top.s >= policy.accept[bucket]! && margin >= policy.margin) best.set(c.cluster, { person: top.k, score: top.s, margin, bucket });
    else unknownScore.set(c.cluster, { score: top.s, margin });
  }

  const labels = new Map<number, SpeakerLabel & { margin: number | null }>();
  const merges: Array<{ from: number; into: number }> = [];
  const byPerson = new Map<string, number[]>();
  for (const [cluster, b] of best) byPerson.set(b.person.personId, [...(byPerson.get(b.person.personId) ?? []), cluster]);
  for (const list of byPerson.values()) {
    list.sort((a, b) => best.get(b)!.score - best.get(a)!.score);
    const owner = list[0]!;
    const b = best.get(owner)!;
    labels.set(owner, {
      key: `${prefix}${owner}`,
      name: b.person.name,
      personId: b.person.personId,
      score: b.score,
      margin: b.margin,
      confidence: b.score >= policy.strong[b.bucket]! ? "high" : "medium",
    });
    for (const other of list.slice(1)) {
      if (!cannotLink(owner, other)) merges.push({ from: other, into: owner });
      else unknownScore.set(other, { score: best.get(other)!.score, margin: best.get(other)!.margin });
    }
  }
  // A merged fragment speaks under its owner's label (same key).
  for (const m of merges) labels.set(m.from, labels.get(m.into)!);
  // The rest are unknown; assembly numbers them by first line.
  for (const c of [...clusters].sort((a, b) => a.firstStart - b.firstStart)) {
    if (labels.has(c.cluster) || merges.some((m) => m.from === c.cluster)) continue;
    const u = unknownScore.get(c.cluster) ?? null;
    labels.set(c.cluster, { key: `${prefix}${c.cluster}`, name: "Speaker", personId: null, score: u?.score ?? null, margin: u?.margin ?? null, confidence: "low" });
  }
  return { labels, merges };
}

interface WordSpeaker {
  cluster: number | null;
  /** Length of the diarization turn behind the decision (ms), for smoothing. */
  turnMs: number;
  competing: boolean;
  uncertain: boolean;
}

/** A one-word speaker change backed by a turn shorter than this is treated as diarization jitter. */
const JITTER_MS = 500;

/**
 * Who said each word of one segment. A word goes to the turn it overlaps; where turns overlap,
 * the previous word's speaker keeps it if they are among them, else the largest overlap wins.
 * Words outside every turn take the nearest turn within `slack`; failing that, the segment's
 * most common speaker (or the nearest turn at all), flagged uncertain. A single word flipped to
 * another speaker by a very short turn, between two words of the same speaker, is put back.
 */
function wordSpeakers(seg: Segment, turns: Turn[], slack: number): WordSpeaker[] {
  let prev: number | null = null;
  const out: WordSpeaker[] = seg.words.map((w) => {
    const ov = new Map<number, { ms: number; turnMs: number; weak: boolean }>();
    for (const t of turns) {
      const o = Math.min(t.end, w.end) - Math.max(t.start, w.start);
      if (o <= 0 && !(w.end === w.start && t.start <= w.start && w.start <= t.end)) continue;
      const cur = ov.get(t.cluster) ?? { ms: 0, turnMs: 0, weak: false };
      ov.set(t.cluster, { ms: cur.ms + Math.max(o, 0), turnMs: Math.max(cur.turnMs, t.end - t.start), weak: cur.weak || !!t.uncertain });
    }
    if (ov.size) {
      // Largest overlap; on a tie, the longer turn.
      const ranked = [...ov].sort(([, a], [, b]) => b.ms - a.ms || b.turnMs - a.turnMs);
      const pick = prev !== null && ov.has(prev) ? prev : ranked[0]![0];
      prev = pick;
      return { cluster: pick, turnMs: ov.get(pick)!.turnMs, competing: ov.size > 1, uncertain: ov.get(pick)!.weak };
    }
    const near = nearestTurn(turns, w.start, w.end);
    if (near && near.dist <= slack) {
      prev = near.turn.cluster;
      return { cluster: near.turn.cluster, turnMs: near.turn.end - near.turn.start, competing: false, uncertain: !!near.turn.uncertain };
    }
    return { cluster: null, turnMs: 0, competing: false, uncertain: true };
  });

  // Unplaced words: the segment's most common speaker, or the nearest turn at all.
  if (out.some((x) => x.cluster === null)) {
    const counts = new Map<number, number>();
    for (const x of out) if (x.cluster !== null) counts.set(x.cluster, (counts.get(x.cluster) ?? 0) + 1);
    let fill: number | null = null;
    let n = 0;
    for (const [c, k] of counts) if (k > n) [n, fill] = [k, c];
    fill ??= nearestTurn(turns, seg.start, seg.end)?.turn.cluster ?? null;
    for (const x of out) if (x.cluster === null) x.cluster = fill;
  }

  // Jitter: X X Y X where Y is one short word from a very short turn → X X X X.
  for (let i = 1; i + 1 < out.length; i++) {
    const [a, b, c] = [out[i - 1]!, out[i]!, out[i + 1]!];
    const w = seg.words[i]!;
    if (b.cluster !== a.cluster && a.cluster === c.cluster && b.turnMs < JITTER_MS && w.end - w.start <= JITTER_MS) {
      b.cluster = a.cluster;
      b.uncertain = true;
    }
  }
  return out;
}

function nearestTurn(turns: Turn[], start: number, end: number): { turn: Turn; dist: number } | null {
  let best: { turn: Turn; dist: number } | null = null;
  for (const t of turns) {
    const d = end < t.start ? t.start - end : start > t.end ? start - t.end : 0;
    if (!best || d < best.dist) best = { turn: t, dist: d };
  }
  return best;
}

/**
 * Split recognized segments into transcript lines by speaker. Words are assigned to the
 * diarization turns they overlap, so a segment where the speaker changes becomes two lines.
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
    const who = opts.fixedKey ? null : wordSpeakers(seg, opts.turns ?? [], slack);
    for (let i = 0; i < seg.words.length; i++) {
      const w = seg.words[i]!;
      let key: string;
      let uncertain = false;
      let competing = false;
      if (opts.fixedKey) key = opts.fixedKey;
      else {
        const s = who![i]!;
        competing = s.competing;
        uncertain = s.uncertain;
        key = s.cluster === null ? "unknown" : opts.keyFor ? opts.keyFor(s.cluster) : `c${s.cluster}`;
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
