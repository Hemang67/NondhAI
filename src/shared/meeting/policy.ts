import type { MatchPolicy } from "./speakers";
import type { PieceOptions, ReclusterOptions } from "./refine";

/**
 * Speaker settings for the current voice model (NeMo TitaNet-small), calibrated with the speaker
 * evaluation (scripts/speaker-eval; results in docs/evidence/speaker-id/README.md). Re-calibrate
 * whenever the model changes: thresholds are not portable between embedding models.
 */
export const DIARIZATION: { threshold: number; refine: PieceOptions & ReclusterOptions } = {
  // sherpa's first pass stays fine-grained (pure fragments); re-clustering joins them.
  threshold: 0.5,
  refine: {
    // Best region of the sweep (merge 0.35–0.45 × min 4–6 s); 0.40 mixes people least.
    mergeThreshold: 0.4,
    // Less clear speech than this can't be a speaker on its own (folded in, flagged if weak).
    minClusterMs: 4000,
    // sherpa sometimes gives one voice two overlapping turns; only a sustained 5 s of
    // simultaneous speech is trusted as proof of two people (1–3 s vetoed correct merges).
    cannotLinkMs: 5000,
    reassignThreshold: 0.5,
    reassignMargin: 0.05,
  },
};

/**
 * When a meeting speaker is recognised as a known person. Accept thresholds sit at or above the
 * worst impostor score measured for each amount of speech (0 false accepts, 0 false rejects on
 * the calibration probes); "high" costs 1.9 % of 6 s matches, 0 % above.
 */
export const MATCH_POLICY: MatchPolicy = {
  buckets: [10000, 30000],
  accept: [0.54, 0.5, 0.47],
  strong: [0.62, 0.58, 0.55],
  margin: 0.05,
  minSpeechMs: 4000,
  topK: 3,
};
