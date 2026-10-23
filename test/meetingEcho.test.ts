import { describe, expect, it } from "vitest";
import { removeEchoWords } from "@shared/meeting/echo";
import { tokensToWords, confidenceFromLogProbs } from "@shared/meeting/words";
import type { Segment } from "@shared/meeting/types";

function seg(channel: "mic" | "system", text: string, start: number, step = 300): Segment {
  const words = text.split(" ").map((w, i) => ({ w, start: start + i * step, end: start + (i + 1) * step }));
  return { id: `${channel}-${start}`, channel, start, end: words.at(-1)!.end, text, words, conf: 0.9 };
}

describe("tokensToWords", () => {
  it("groups sentencepiece tokens into timed words", () => {
    const words = tokensToWords([" U", "m", ",", " let", "'", "s", " me", "et"], [2.16, 2.16, 2.32, 2.48, 2.56, 2.56, 2.72, 2.72], 1000, 99999);
    expect(words.map((w) => w.w)).toEqual(["Um,", "let's", "meet"]);
    expect(words[0]!.start).toBe(3160);
    expect(words[1]!.start).toBe(3480);
    expect(words[0]!.end).toBe(3480);
  });

  it("averages log-probs into a confidence", () => {
    expect(confidenceFromLogProbs([0, 0])).toBe(1);
    expect(confidenceFromLogProbs([Math.log(0.5)])).toBeCloseTo(0.5);
    expect(confidenceFromLogProbs(undefined)).toBe(1);
  });
});

describe("removeEchoWords", () => {
  const sys = [seg("system", "let's meet on Tuesday no Wednesday at three", 2000)];

  it("drops mic words that repeat the system track shortly after", () => {
    const mic = [seg("mic", "let's meet on Tuesday no Wednesday", 2150)];
    const r = removeEchoWords(mic, sys);
    expect(r.segments).toEqual([]);
    expect(r.removedWords).toBe(6);
  });

  it("keeps my own words in a segment that also contains echo (double-talk)", () => {
    const mic = [seg("mic", "Wednesday at three sounds good to me", 3700)];
    const r = removeEchoWords(mic, sys);
    expect(r.segments[0]!.text).toBe("sounds good to me");
    expect(r.segments[0]!.start).toBe(3700 + 3 * 300);
  });

  it("keeps a single coincidental matching word", () => {
    const mic = [seg("mic", "Tuesday works", 4000)];
    expect(removeEchoWords(mic, sys).segments[0]!.text).toBe("Tuesday works");
  });

  it("keeps repeats that are far apart in time (I quote someone later)", () => {
    const mic = [seg("mic", "meet on Tuesday", 60000)];
    expect(removeEchoWords(mic, sys).segments).toHaveLength(1);
  });

  it("ignores punctuation and case when matching", () => {
    const mic = [seg("mic", "Let's MEET, on", 2100)];
    expect(removeEchoWords(mic, sys).segments).toHaveLength(0);
  });
});
