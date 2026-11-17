import type { Word } from "./types";

/**
 * Turn sentencepiece tokens (a leading space starts a new word) with per-token start times in
 * seconds into words with ms times relative to the meeting. `offsetMs` is where the decoded
 * audio starts on the meeting timeline; `endMs` closes the last word.
 */
export function tokensToWords(tokens: string[], timestamps: number[], offsetMs: number, endMs: number): Word[] {
  const words: Word[] = [];
  const pieces: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const t = offsetMs + Math.round((timestamps[i] ?? 0) * 1000);
    const startsWord = tok.startsWith(" ") || tok.startsWith("▁") || words.length === 0;
    const piece = tok.replace(/^[ ▁]/, "");
    if (startsWord) {
      if (words.length) words[words.length - 1]!.end = Math.min(t, words[words.length - 1]!.start + spokenMs(pieces[pieces.length - 1]!));
      words.push({ w: piece, start: t, end: t });
      pieces.push(1);
    } else {
      words[words.length - 1]!.w += piece;
      pieces[pieces.length - 1]!++;
    }
  }
  if (words.length) {
    const last = words[words.length - 1]!;
    last.end = Math.max(last.start + 200, Math.min(endMs, last.start + spokenMs(pieces[pieces.length - 1]!)));
  }
  return words.filter((w) => w.w.length > 0);
}

/**
 * Rough time a word takes to say, from its token count. Token times are onsets only, so without
 * a cap a word would also own the pause after it, and speaker assignment would leak into the
 * next person's turn.
 */
const spokenMs = (tokens: number) => 160 + 160 * tokens;

/** Mean token probability from log-probs, as 0..1. */
export function confidenceFromLogProbs(logProbs: number[] | undefined): number {
  if (!logProbs?.length) return 1;
  const mean = logProbs.reduce((a, b) => a + Math.exp(b), 0) / logProbs.length;
  return Math.max(0, Math.min(1, mean));
}

export const normalizeWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
