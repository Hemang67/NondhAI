import { describe, expect, it } from "vitest";
import { assembleTranscript } from "@shared/meeting/assemble";
import type { Segment } from "@shared/meeting/types";

function seg(channel: "mic" | "system" | "mixed", text: string, start: number): Segment {
  const words = text.split(" ").map((w, i) => ({ w, start: start + i * 300, end: start + (i + 1) * 300 }));
  return { id: `${channel}${start}`, channel, start, end: words.at(-1)!.end, text, words, conf: 0.9 };
}

/** Matching policy for unit tests (real values are calibrated per model in policy.ts). */
const policy = { buckets: [10000, 30000], accept: [0.8, 0.7, 0.6], strong: [0.9, 0.85, 0.8], margin: 0.1, minSpeechMs: 4000, topK: 3 };

const voices = [
  { personId: "me1", name: "Hemang", isMe: true, embeddings: [[1, 0, 0]] },
  { personId: "p1", name: "Priya", isMe: false, embeddings: [[0, 1, 0]] },
];

describe("assembleTranscript — call", () => {
  it("labels the mic as me, removes echo, and names known voices on the system track", () => {
    const out = assembleTranscript({
      kind: "call",
      primary: [seg("mic", "the deck looks good to me", 5000), seg("mic", "pricing is final", 600)],
      system: [seg("system", "pricing is final", 500), seg("system", "send it over", 9000)],
      turns: [
        { start: 0, end: 2000, cluster: 0 },
        { start: 8800, end: 11000, cluster: 1 },
      ],
      clusters: [
        { cluster: 0, embedding: [0.05, 0.98, 0], firstStart: 0, cleanMs: 60000 },
        { cluster: 1, embedding: [0, 0, 1], firstStart: 8800, cleanMs: 60000 },
      ],
      voices,
      policy,
    });
    expect(out.echoWordsRemoved).toBe(3);
    expect(out.lines.map((l) => [l.speakerKey, l.text])).toEqual([
      ["c0", "pricing is final"],
      ["me", "the deck looks good to me"],
      ["c1", "send it over"],
    ]);
    const names = Object.fromEntries(out.speakers.map((s) => [s.key, s.name]));
    expect(names).toEqual({ me: "Me", c0: "Priya", c1: "Speaker 1" });
    expect(out.speakers.find((s) => s.key === "c0")!.confidence).toBe("high");
  });

  it("numbers unknown speakers by when they first speak, skipping clusters that got no words", () => {
    const out = assembleTranscript({
      kind: "call",
      primary: [],
      system: [seg("system", "first words here", 4000), seg("system", "and then me", 9000)],
      turns: [
        { start: 0, end: 800, cluster: 5 }, // a cough: no words land here
        { start: 3900, end: 5000, cluster: 2 },
        { start: 8900, end: 10000, cluster: 0 },
      ],
      clusters: [
        { cluster: 5, embedding: null, firstStart: 0 },
        { cluster: 2, embedding: null, firstStart: 3900 },
        { cluster: 0, embedding: null, firstStart: 8900 },
      ],
      voices: [],
      policy,
    });
    expect(out.speakers.map((s) => [s.key, s.name])).toEqual([
      ["c2", "Speaker 1"],
      ["c0", "Speaker 2"],
    ]);
  });

  it("merges two fragments of a known person into one speaker", () => {
    const out = assembleTranscript({
      kind: "call",
      primary: [],
      system: [seg("system", "the pricing", 0), seg("system", "is final", 20000)],
      turns: [
        { start: 0, end: 1000, cluster: 0 },
        { start: 19900, end: 21000, cluster: 1 },
      ],
      clusters: [
        { cluster: 0, embedding: [0.05, 0.98, 0], firstStart: 0, cleanMs: 60000 },
        { cluster: 1, embedding: [0.1, 0.95, 0.05], firstStart: 19900, cleanMs: 60000 },
      ],
      voices,
      policy,
    });
    expect(out.lines.map((l) => l.speakerKey)).toEqual(["c0", "c0"]);
    expect(out.speakers.map((s) => [s.key, s.name])).toEqual([["c0", "Priya"]]);
  });

  it("falls back to a single 'Others' speaker without diarization", () => {
    const out = assembleTranscript({
      kind: "call",
      primary: [],
      system: [seg("system", "hello there", 0)],
      turns: [],
      clusters: [],
      voices: [],
      policy,
    });
    expect(out.lines[0]!.speakerKey).toBe("others");
    expect(out.speakers.map((s) => s.name)).toEqual(["Others"]);
  });
});

describe("assembleTranscript — room", () => {
  it("finds me by enrolled voice and numbers the others", () => {
    const out = assembleTranscript({
      kind: "room",
      primary: [seg("mixed", "good morning all", 0), seg("mixed", "morning", 3000)],
      turns: [
        { start: 0, end: 1000, cluster: 4 },
        { start: 2900, end: 3400, cluster: 7 },
      ],
      clusters: [
        { cluster: 4, embedding: [0.97, 0.05, 0.1], firstStart: 0, cleanMs: 60000 },
        { cluster: 7, embedding: [0, 0.1, 1], firstStart: 2900, cleanMs: 60000 },
      ],
      voices,
      policy,
    });
    expect(out.lines.map((l) => l.speakerKey)).toEqual(["me", "c7"]);
    expect(out.speakers.map((s) => [s.key, s.name])).toEqual([
      ["me", "Me"],
      ["c7", "Speaker 1"],
    ]);
  });

  it("does not claim me when nobody matches the enrolled voice", () => {
    const out = assembleTranscript({
      kind: "import",
      primary: [seg("mixed", "hello", 0)],
      turns: [{ start: 0, end: 1000, cluster: 0 }],
      clusters: [{ cluster: 0, embedding: [0, 0, 1], firstStart: 0, cleanMs: 60000 }],
      voices,
      policy,
    });
    expect(out.speakers.map((s) => s.name)).toEqual(["Speaker 1"]);
  });
});
