/**
 * Verification error rates for voice matching: a trial is a similarity score between two voice
 * samples and whether they really are the same person. A score at or above the threshold is
 * accepted as "same".
 */
export interface Trial {
  score: number;
  same: boolean;
}

export function ratesAt(trials: Trial[], threshold: number): { far: number; frr: number } {
  const same = trials.filter((t) => t.same);
  const diff = trials.filter((t) => !t.same);
  return {
    far: diff.length ? diff.filter((t) => t.score >= threshold).length / diff.length : 0,
    frr: same.length ? same.filter((t) => t.score < threshold).length / same.length : 0,
  };
}

/** Candidate thresholds: every score, plus just above the highest. */
function candidates(trials: Trial[]): number[] {
  const s = [...new Set(trials.map((t) => t.score))].sort((a, b) => a - b);
  return [...s, (s.at(-1) ?? 0) + 1e-6];
}

/** The point where false accepts and false rejects are closest (their mean there). */
export function equalErrorRate(trials: Trial[]): { eer: number; threshold: number } {
  let best = { gap: Infinity, eer: 1, threshold: 0 };
  for (const th of candidates(trials)) {
    const { far, frr } = ratesAt(trials, th);
    const gap = Math.abs(far - frr);
    if (gap < best.gap || (gap === best.gap && (far + frr) / 2 < best.eer)) best = { gap, eer: (far + frr) / 2, threshold: th };
  }
  return { eer: best.eer, threshold: best.threshold };
}

/** Lowest threshold whose false-accept rate is at most `targetFar`. */
export function thresholdForFar(trials: Trial[], targetFar: number): number {
  const diff = trials.filter((t) => !t.same).map((t) => t.score).sort((a, b) => b - a);
  if (!diff.length) return -Infinity;
  // Allow at most k impostor scores at or above the threshold.
  const k = Math.floor(targetFar * diff.length + 1e-9);
  return k >= diff.length ? -Infinity : diff[k]! + 1e-6;
}
