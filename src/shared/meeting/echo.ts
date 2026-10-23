import type { Segment, Word } from "./types";
import { normalizeWord } from "./words";

/**
 * Text-level echo removal. When the other people's voices leak from the speakers into the mic,
 * the mic track repeats words the system track already has, a few hundred ms later. Acoustic
 * echo cancellation removes most of that; this removes what is left, so it is never
 * transcribed twice.
 *
 * A mic word is echo when it starts a run of at least `minRun` consecutive mic words that
 * match consecutive system words, and each matched pair lies within `windowMs` of each other.
 * Single coincidental words ("yes", "okay") are kept, since the user may really have said them.
 */
export interface EchoOptions {
  windowMs: number;
  minRun: number;
}

const DEFAULTS: EchoOptions = { windowMs: 2500, minRun: 2 };

export function removeEchoWords(mic: Segment[], system: Segment[], opts: Partial<EchoOptions> = {}): {
  segments: Segment[];
  removedWords: number;
} {
  const o = { ...DEFAULTS, ...opts };
  const sysWords = system.flatMap((s) => s.words).filter((w) => normalizeWord(w.w));
  const sysNorm = sysWords.map((w) => normalizeWord(w.w));
  let removed = 0;
  const out: Segment[] = [];
  for (const seg of mic) {
    const words = seg.words.filter((w) => normalizeWord(w.w));
    const drop = new Array<boolean>(words.length).fill(false);
    const norm = words.map((w) => normalizeWord(w.w));
    for (let i = 0; i < words.length; i++) {
      if (drop[i]) continue;
      const len = longestMatchAt(words, norm, i, sysWords, sysNorm, o.windowMs);
      if (len >= o.minRun) for (let k = 0; k < len; k++) drop[i + k] = true;
    }
    const kept = words.filter((_, i) => !drop[i]);
    removed += words.length - kept.length;
    if (!kept.length) continue;
    if (kept.length === words.length) {
      out.push(seg);
      continue;
    }
    out.push({
      ...seg,
      words: kept,
      text: kept.map((w) => w.w).join(" "),
      start: kept[0]!.start,
      end: kept[kept.length - 1]!.end,
    });
  }
  return { segments: out, removedWords: removed };
}

function longestMatchAt(
  mic: Word[],
  micNorm: string[],
  i: number,
  sys: Word[],
  sysNorm: string[],
  windowMs: number,
): number {
  let best = 0;
  for (let j = 0; j < sys.length; j++) {
    if (sysNorm[j] !== micNorm[i] || Math.abs(mic[i]!.start - sys[j]!.start) > windowMs) continue;
    let k = 0;
    while (
      i + k < mic.length &&
      j + k < sys.length &&
      micNorm[i + k] === sysNorm[j + k] &&
      Math.abs(mic[i + k]!.start - sys[j + k]!.start) <= windowMs
    ) {
      k++;
    }
    best = Math.max(best, k);
  }
  return best;
}
