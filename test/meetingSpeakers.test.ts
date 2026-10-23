import { describe, expect, it } from "vitest";
import { cosine, labelClusters, linesFromSegments, matchVoice, mergeLines, meanVector } from "@shared/meeting/speakers";
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

describe("voice matching", () => {
  const known = [
    { personId: "p1", name: "Priya", embeddings: [v(1, 0, 0)] },
    { personId: "p2", name: "Mark", embeddings: [v(0, 1, 0)] },
  ];

  it("computes cosine similarity and mean vectors", () => {
    expect(cosine(v(1, 0), v(1, 0))).toBeCloseTo(1);
    expect(cosine(v(1, 0), v(0, 1))).toBeCloseTo(0);
    expect(Array.from(meanVector([v(1, 0), v(0, 1)]))).toEqual([0.5, 0.5]);
  });

  it("returns a high-confidence match for a close voice with a clear margin", () => {
    expect(matchVoice(v(0.95, 0.1, 0.05), known)).toMatchObject({ personId: "p1", confidence: "high" });
  });

  it("returns medium confidence when two people are similarly close", () => {
    expect(matchVoice(v(0.68, 0.66, 0), known)?.confidence).toBe("medium");
  });

  it("returns no match below the acceptance threshold", () => {
    expect(matchVoice(v(0, 0, 1), known)).toBeNull();
  });

  it("never gives the same person to two clusters, and numbers the rest by first appearance", () => {
    const labels = labelClusters(
      [
        { cluster: 0, embedding: v(0, 0, 1), firstStart: 5000 },
        { cluster: 1, embedding: v(0.9, 0.1, 0), firstStart: 1000 },
        { cluster: 2, embedding: v(0.8, 0.2, 0), firstStart: 0 },
      ],
      known,
    );
    expect(labels.get(1)!.name).toBe("Priya");
    expect(labels.get(2)!.name).toBe("Speaker 1"); // Priya is already taken by the stronger match
    expect(labels.get(0)!.name).toBe("Speaker 2");
    expect(labels.get(0)!.confidence).toBe("low");
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
