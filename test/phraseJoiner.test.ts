import { describe, expect, it } from "vitest";
import { PhraseJoiner, joinPhrases } from "@shared/speech/phraseJoiner";

describe("joinPhrases", () => {
  it("joins complete sentences with spaces", () => {
    expect(joinPhrases(["Hello there.", "How are you?"])).toBe("Hello there. How are you?");
  });

  it("removes a guessed full stop when the next phrase continues the sentence", () => {
    expect(joinPhrases(["We should move the meeting.", "to Wednesday."])).toBe("We should move the meeting to Wednesday.");
  });

  it("adds a stop between an unterminated phrase and a new sentence", () => {
    expect(joinPhrases(["Thanks for joining", "Let's get started."])).toBe("Thanks for joining. Let's get started.");
  });

  it("does not treat a leading 'I' as a new sentence", () => {
    expect(joinPhrases(["So yesterday", "I went home."])).toBe("So yesterday I went home.");
  });

  it("skips empty phrases", () => {
    expect(joinPhrases(["", "  ", "Hi."])).toBe("Hi.");
  });
});

describe("PhraseJoiner", () => {
  it("decodes sequentially and returns phrases in spoken order even if decodes finish out of order", async () => {
    let active = 0;
    let maxActive = 0;
    const delays = [30, 5, 10];
    let n = 0;
    const j = new PhraseJoiner(async (s) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, delays[n++]));
      active--;
      return `Phrase ${s[0]}.`;
    });
    j.push(new Float32Array([1]));
    j.push(new Float32Array([2]));
    j.push(new Float32Array([3]));
    expect(await j.finish()).toBe("Phrase 1. Phrase 2. Phrase 3.");
    expect(maxActive).toBe(1);
  });

  it("stops decoding after abort", async () => {
    let calls = 0;
    const j = new PhraseJoiner(async () => {
      calls++;
      return "x";
    });
    j.abort();
    j.push(new Float32Array(1));
    await j.finish();
    expect(calls).toBe(0);
  });
});
