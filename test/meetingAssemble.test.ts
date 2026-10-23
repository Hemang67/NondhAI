import { describe, expect, it } from "vitest";
import { assembleTranscript } from "@shared/meeting/assemble";
import type { Segment } from "@shared/meeting/types";

function seg(channel: "mic" | "system" | "mixed", text: string, start: number): Segment {
  const words = text.split(" ").map((w, i) => ({ w, start: start + i * 300, end: start + (i + 1) * 300 }));
  return { id: `${channel}${start}`, channel, start, end: words.at(-1)!.end, text, words, conf: 0.9 };
}

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
        { cluster: 0, embedding: [0.05, 0.98, 0], firstStart: 0 },
        { cluster: 1, embedding: [0, 0, 1], firstStart: 8800 },
      ],
      voices,
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

  it("falls back to a single 'Others' speaker without diarization", () => {
    const out = assembleTranscript({
      kind: "call",
      primary: [],
      system: [seg("system", "hello there", 0)],
      turns: [],
      clusters: [],
      voices: [],
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
        { cluster: 4, embedding: [0.97, 0.05, 0.1], firstStart: 0 },
        { cluster: 7, embedding: [0, 0.1, 1], firstStart: 2900 },
      ],
      voices,
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
      clusters: [{ cluster: 0, embedding: [0, 0, 1], firstStart: 0 }],
      voices,
    });
    expect(out.speakers.map((s) => s.name)).toEqual(["Speaker 1"]);
  });
});
