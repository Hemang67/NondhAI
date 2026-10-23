/**
 * Decodes speech phrases in the order they were spoken while new ones keep arriving, so that
 * when recording stops only the last phrase is left to decode. Decoding is sequential (one
 * recognizer, one CPU budget) and results are joined in original order.
 */
export type Decode = (samples: Float32Array) => Promise<string>;

export class PhraseJoiner {
  private readonly texts: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private aborted = false;
  private count = 0;

  constructor(private readonly decode: Decode) {}

  push(samples: Float32Array): void {
    const index = this.count++;
    this.chain = this.chain.then(async () => {
      if (this.aborted) return;
      this.texts[index] = (await this.decode(samples)).trim();
    });
  }

  abort(): void {
    this.aborted = true;
  }

  get pending(): number {
    return this.count;
  }

  async finish(): Promise<string> {
    await this.chain;
    return joinPhrases(this.texts.filter((t): t is string => !!t));
  }
}

/** Join decoded phrases, smoothing the seams a split creates ("we should. Go" → "we should go"). */
export function joinPhrases(parts: string[]): string {
  let out = "";
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (!out) {
      out = p;
      continue;
    }
    const prevEndsSentence = /[.!?]["')\]]?$/.test(out);
    const nextStartsLower = /^[a-z]/.test(p);
    if (prevEndsSentence && nextStartsLower) {
      // A pause mid-sentence: the recognizer guessed a full stop. Undo it.
      out = out.replace(/[.]$/, "") + " " + p;
    } else if (!prevEndsSentence && /^[A-Z][a-z]/.test(p) && !/^(I|I'm|I'll|I've|I'd)\b/.test(p)) {
      // New phrase that looks like a new sentence after a missing stop.
      out = out + ". " + p;
    } else {
      out = out + " " + p;
    }
  }
  return out;
}
