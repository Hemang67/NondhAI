/**
 * The speaker matching NondhAI used before the speaker-identification work (one fixed 0.55
 * threshold, best single sample, one person per cluster). Kept only so the evaluation can
 * measure "today" against the new pipeline; the app uses identify() in speakers.ts.
 */
import { cosine, type KnownVoice } from "@shared/meeting/speakers";
import type { ConfidenceLevel, SpeakerLabel } from "@shared/meeting/types";

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
