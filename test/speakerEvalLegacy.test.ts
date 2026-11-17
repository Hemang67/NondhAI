import { describe, expect, it } from "vitest";
import { labelClusters, matchVoice } from "../scripts/speaker-eval/legacy";

const v = (...x: number[]) => Float32Array.from(x);

describe("legacy voice matching (evaluation baseline)", () => {
  const known = [
    { personId: "p1", name: "Priya", embeddings: [v(1, 0, 0)] },
    { personId: "p2", name: "Mark", embeddings: [v(0, 1, 0)] },
  ];

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
