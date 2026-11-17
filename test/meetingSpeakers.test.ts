import { describe, expect, it } from "vitest";
import { VOICE_SAVE, cosine, identify, linesFromSegments, mergeLines, profileScore, voiceQuality, voiceprintToSave } from "@shared/meeting/speakers";
import type { Segment } from "@shared/meeting/types";

const v = (...x: number[]) => Float32Array.from(x);

function seg(channel: "mic" | "system", words: Array<[string, number]>): Segment {
  return {
    id: `${channel}-${words[0]![1]}`,
    channel,
    start: words[0]![1],
    end: words.at(-1)![1] + 300,
    text: words.map((w) => w[0]).join(" "),
    words: words.map(([w, t]) => ({ w, start: t, end: t + 300 })),
    conf: 0.9,
  };
}

describe("cosine", () => {
  it("computes cosine similarity", () => {
    expect(cosine(v(1, 0), v(1, 0))).toBeCloseTo(1);
    expect(cosine(v(1, 0), v(0, 1))).toBeCloseTo(0);
  });
});

describe("voiceQuality", () => {
  it("is zero (not worth remembering) with under 10 s of clear speech", () => {
    expect(voiceQuality(9000, 0.95)).toBe(0);
  });

  it("is zero for a cluster whose voice is inconsistent (likely two people)", () => {
    expect(voiceQuality(120000, VOICE_SAVE.minCohesion - 0.01)).toBe(0);
  });

  it("rises with more clear speech and a more consistent voice, up to 1", () => {
    const c = VOICE_SAVE.minCohesion + 0.05;
    expect(voiceQuality(20000, c)).toBeGreaterThan(0);
    expect(voiceQuality(60000, c)).toBeGreaterThan(voiceQuality(20000, c));
    expect(voiceQuality(60000, 0.99)).toBeGreaterThan(voiceQuality(60000, c));
    expect(voiceQuality(600000, 1)).toBeLessThanOrEqual(1);
  });
});

describe("voiceprintToSave", () => {
  const sp = { embedding: v(1, 0), cleanMs: 45000, cohesion: 0.9, model: "titanet-small-v1" };

  it("saves a well-evidenced voice made by the current model, with its quality", () => {
    expect(voiceprintToSave(sp, "titanet-small-v1")).toMatchObject({ quality: voiceQuality(45000, 0.9), speechMs: 45000 });
  });

  it("refuses a voice embedded by another (older) model", () => {
    expect(voiceprintToSave({ ...sp, model: null }, "titanet-small-v1")).toBeNull();
    expect(voiceprintToSave({ ...sp, model: "campplus-v1" }, "titanet-small-v1")).toBeNull();
  });

  it("refuses a voice with too little clear speech", () => {
    expect(voiceprintToSave({ ...sp, cleanMs: 5000 }, "titanet-small-v1")).toBeNull();
  });
});

describe("identify (calibrated matching)", () => {
  const policy = { buckets: [10000, 30000], accept: [0.8, 0.7, 0.6], strong: [0.9, 0.85, 0.8], margin: 0.1, minSpeechMs: 4000, topK: 3 };
  const people = [
    { personId: "p1", name: "Priya", embeddings: [v(1, 0, 0), v(0.9, 0.1, 0)], qualities: [1, 1] },
    { personId: "p2", name: "Mark", embeddings: [v(0, 1, 0)], qualities: [1] },
  ];
  const cl = (cluster: number, e: number[], cleanMs = 60000) => ({ cluster, embedding: v(...e), cleanMs, firstStart: cluster * 1000 });

  it("scores a person by the quality-weighted mean of their best samples, not the single best", () => {
    const p = { personId: "x", name: "X", embeddings: [v(1, 0, 0), v(0, 1, 0), v(0, 0, 1)], qualities: [1, 1, 1] };
    expect(profileScore(v(1, 0, 0), p, 1)).toBeCloseTo(1);
    expect(profileScore(v(1, 0, 0), p, 3)).toBeCloseTo(1 / 3);
    const weighted = { ...p, qualities: [1, 0.1, 0.1] };
    expect(profileScore(v(1, 0, 0), weighted, 3)).toBeGreaterThan(0.8);
  });

  it("names a cluster when the score passes its bucket's threshold with a clear margin", () => {
    const r = identify([cl(0, [0.97, 0.05, 0])], people, policy);
    expect(r.labels.get(0)).toMatchObject({ personId: "p1", name: "Priya", confidence: "high" });
    expect(r.labels.get(0)!.margin).toBeGreaterThan(0.5);
  });

  it("needs a higher score from a cluster with little speech", () => {
    const e = [0.75, 0.3, 0.55];
    expect(identify([cl(0, e, 60000)], people, policy).labels.get(0)!.personId).toBe("p1");
    expect(identify([cl(0, e, 8000)], people, policy).labels.get(0)!.personId).toBeNull();
  });

  it("never names a cluster with too little speech to judge", () => {
    expect(identify([cl(0, [1, 0, 0], 2000)], people, policy).labels.get(0)!.personId).toBeNull();
  });

  it("leaves a cluster unknown when two people are about equally close", () => {
    const r = identify([cl(0, [0.7, 0.68, 0.1])], people, policy);
    expect(r.labels.get(0)).toMatchObject({ personId: null, confidence: "low" });
  });

  it("merges two fragments of the same known person instead of naming the second as someone else", () => {
    const r = identify([cl(0, [0.97, 0.05, 0]), cl(1, [0.9, 0.12, 0.05])], people, policy);
    expect(r.merges).toEqual([{ from: 1, into: 0 }]);
    expect(r.labels.get(1)!.personId).not.toBe("p2");
  });

  it("does not merge fragments that talk at the same time; the weaker stays unknown", () => {
    const r = identify([cl(0, [0.97, 0.05, 0]), cl(1, [0.9, 0.12, 0.05])], people, policy, () => true);
    expect(r.merges).toEqual([]);
    expect(r.labels.get(1)).toMatchObject({ personId: null });
  });
});

describe("linesFromSegments", () => {
  it("labels every mic word as me", () => {
    const lines = linesFromSegments([seg("mic", [["hello", 0], ["there", 300]])], { fixedKey: "me" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ speakerKey: "me", text: "hello there" });
  });

  it("splits a system segment where the diarized speaker changes", () => {
    const turns = [
      { start: 0, end: 1000, cluster: 0 },
      { start: 1000, end: 3000, cluster: 1 },
    ];
    const lines = linesFromSegments([seg("system", [["yes", 0], ["agreed", 400], ["but", 1200], ["wait", 1600]])], { turns });
    expect(lines.map((l) => [l.speakerKey, l.text])).toEqual([
      ["c0", "yes agreed"],
      ["c1", "but wait"],
    ]);
  });

  it("marks words outside any turn as uncertain", () => {
    const lines = linesFromSegments([seg("system", [["hmm", 9000]])], { turns: [{ start: 0, end: 1000, cluster: 0 }] });
    expect(lines[0]!.uncertainSpeaker).toBe(true);
  });

  it("keeps the current speaker for a word where two turns overlap", () => {
    const turns = [
      { start: 900, end: 1500, cluster: 0 },
      { start: 0, end: 2000, cluster: 1 },
    ];
    const lines = linesFromSegments([seg("system", [["I", 0], ["think", 300], ["so", 1100]])], { turns });
    expect(lines.map((l) => [l.speakerKey, l.text])).toEqual([["c1", "I think so"]]);
    expect(lines[0]!.overlap).toBe(true);
  });

  it("absorbs a single word flipped by a tiny turn into the surrounding speaker, flagged", () => {
    const turns = [
      { start: 0, end: 900, cluster: 0 },
      { start: 900, end: 1250, cluster: 1 },
      { start: 1250, end: 3000, cluster: 0 },
    ];
    const s = seg("system", [["we", 0], ["should", 400], ["ship", 950], ["it", 1300], ["today", 1700]]);
    s.words = s.words.map((w) => ({ ...w, end: w.start + 250 }));
    const lines = linesFromSegments([s], { turns });
    expect(lines.map((l) => [l.speakerKey, l.text])).toEqual([["c0", "we should ship it today"]]);
    expect(lines[0]!.uncertainSpeaker).toBe(true);
  });

  it("keeps a one-word interjection when its turn is long enough to trust", () => {
    const turns = [
      { start: 0, end: 900, cluster: 0 },
      { start: 900, end: 1600, cluster: 1 },
      { start: 1600, end: 3000, cluster: 0 },
    ];
    const s = seg("system", [["we", 0], ["should", 400], ["no", 1000], ["it", 1700], ["today", 2100]]);
    s.words = s.words.map((w) => ({ ...w, end: w.start + 250 }));
    expect(linesFromSegments([s], { turns }).map((l) => l.speakerKey)).toEqual(["c0", "c1", "c0"]);
  });

  it("never leaves words with an unknown speaker: they join the segment's speaker, flagged", () => {
    const lines = linesFromSegments([seg("system", [["hmm", 8000], ["right", 9800]])], { turns: [{ start: 9700, end: 11000, cluster: 0 }] });
    expect(lines.map((l) => [l.speakerKey, l.text, l.uncertainSpeaker])).toEqual([["c0", "hmm right", true]]);
  });

  it("flags words whose turn came from a weakly folded fragment", () => {
    const turns = [{ start: 0, end: 2000, cluster: 1, uncertain: true }];
    expect(linesFromSegments([seg("system", [["yes", 100]])], { turns })[0]).toMatchObject({ speakerKey: "c1", uncertainSpeaker: true });
  });

  it("gives a segment far from every turn to the nearest turn's speaker, flagged", () => {
    const lines = linesFromSegments([seg("system", [["hello", 20000]])], { turns: [{ start: 0, end: 1000, cluster: 3 }] });
    expect(lines.map((l) => [l.speakerKey, l.uncertainSpeaker])).toEqual([["c3", true]]);
  });

  it("marks competing turns as overlap", () => {
    const turns = [
      { start: 0, end: 2000, cluster: 0 },
      { start: 0, end: 2000, cluster: 1 },
    ];
    expect(linesFromSegments([seg("system", [["both", 500]])], { turns })[0]!.overlap).toBe(true);
  });
});

describe("mergeLines", () => {
  it("orders by time and flags real overlap between different speakers", () => {
    const me = linesFromSegments([seg("mic", [["I", 1000], ["think", 1300], ["so", 1600]])], { fixedKey: "me" });
    const them = linesFromSegments([seg("system", [["no", 0], ["wait", 300], ["listen", 1200]])], {
      turns: [{ start: 0, end: 3000, cluster: 0 }],
    });
    const merged = mergeLines(me, them);
    expect(merged.map((l) => l.speakerKey)).toEqual(["c0", "me"]);
    expect(merged.every((l) => l.overlap)).toBe(true);
  });

  it("does not flag a brief back-channel as overlap", () => {
    const me = linesFromSegments([seg("mic", [["mm", 2900]])], { fixedKey: "me" });
    me[0]!.end = 3100;
    const them = linesFromSegments([seg("system", [["right", 2500]])], { turns: [{ start: 0, end: 3000, cluster: 0 }] });
    them[0]!.end = 3000;
    expect(mergeLines(me, them).some((l) => l.overlap)).toBe(false);
  });
});
