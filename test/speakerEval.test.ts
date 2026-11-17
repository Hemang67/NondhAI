import { describe, expect, it } from "vitest";
import { parseRttm, scoreDiarization, toRttm, type LabeledTurn } from "@shared/meeting/eval/diarization";
import { equalErrorRate, ratesAt, thresholdForFar } from "@shared/meeting/eval/identity";

const t = (speaker: string, start: number, end: number): LabeledTurn => ({ speaker, start, end });

describe("RTTM", () => {
  it("parses SPEAKER lines grouped by file, in ms", () => {
    const text = [
      "SPEAKER ES2004a 1 0.50 1.25 <NA> <NA> MEE068 <NA> <NA>",
      "SPEAKER ES2004a 1 2.000 0.500 <NA> <NA> FEE005 <NA> <NA>",
      ";; comment",
      "SPEAKER other 1 0 1 <NA> <NA> A <NA> <NA>",
    ].join("\n");
    const m = parseRttm(text);
    expect(m.get("ES2004a")).toEqual([t("MEE068", 500, 1750), t("FEE005", 2000, 2500)]);
    expect(m.get("other")).toEqual([t("A", 0, 1000)]);
  });

  it("writes RTTM that parses back to the same turns, with spaces in names as underscores", () => {
    const turns = [t("Speaker 1", 0, 1500), t("Priya", 1500, 4020)];
    expect(parseRttm(toRttm("m1", turns)).get("m1")).toEqual([t("Speaker_1", 0, 1500), t("Priya", 1500, 4020)]);
  });
});

describe("scoreDiarization", () => {
  const opts = { collarMs: 0 };

  it("scores a perfect hypothesis with different labels as zero error", () => {
    const ref = [t("A", 0, 10000), t("B", 10000, 20000)];
    const hyp = [t("c7", 0, 10000), t("c2", 10000, 20000)];
    const s = scoreDiarization(ref, hyp, opts);
    expect(s.der).toBe(0);
    expect(s.mapping.get("c7")).toBe("A");
    expect(s.mapping.get("c2")).toBe("B");
    expect(s.refSpeakers).toBe(2);
    expect(s.hypSpeakers).toBe(2);
  });

  it("counts a speaker split into two clusters as confusion and as one split", () => {
    const ref = [t("A", 0, 10000), t("B", 10000, 20000)];
    const hyp = [t("x", 0, 7000), t("y", 7000, 10000), t("z", 10000, 20000)];
    const s = scoreDiarization(ref, hyp, opts);
    expect(s.confusionMs).toBe(3000);
    expect(s.der).toBeCloseTo(3000 / 20000);
    expect(s.splitSpeakers).toBe(1);
    expect(s.mergedSpeakers).toBe(0);
    expect(s.hypSpeakers).toBe(3);
  });

  it("counts two speakers merged into one cluster as confusion and as one merge", () => {
    const ref = [t("A", 0, 12000), t("B", 12000, 20000)];
    const hyp = [t("x", 0, 20000)];
    const s = scoreDiarization(ref, hyp, opts);
    expect(s.confusionMs).toBe(8000);
    expect(s.mergedSpeakers).toBe(1);
    expect(s.splitSpeakers).toBe(0);
  });

  it("counts missed speech and false alarms", () => {
    const ref = [t("A", 0, 10000)];
    const hyp = [t("x", 2000, 10000), t("x", 12000, 13000)];
    const s = scoreDiarization(ref, hyp, opts);
    expect(s.missMs).toBe(2000);
    expect(s.falseAlarmMs).toBe(1000);
    expect(s.der).toBeCloseTo(3000 / 10000);
  });

  it("scores overlapped reference speech per speaker", () => {
    const ref = [t("A", 0, 10000), t("B", 5000, 10000)];
    const hyp = [t("x", 0, 10000)];
    const s = scoreDiarization(ref, hyp, opts);
    expect(s.scoredMs).toBe(15000);
    expect(s.missMs).toBe(5000);
    expect(s.confusionMs).toBe(0);
  });

  it("does not score speech within the collar around reference boundaries", () => {
    const ref = [t("A", 0, 10000), t("B", 10000, 20000)];
    const hyp = [t("x", 0, 10200), t("y", 10200, 20000)];
    expect(scoreDiarization(ref, hyp, { collarMs: 0 }).der).toBeGreaterThan(0);
    expect(scoreDiarization(ref, hyp, { collarMs: 250 }).der).toBe(0);
  });

  it("reports each hypothesis speaker's dominant reference speaker, even when unmapped", () => {
    const ref = [t("A", 0, 10000), t("B", 10000, 20000)];
    const hyp = [t("x", 0, 7000), t("y", 7000, 10000), t("z", 10000, 20000)];
    const s = scoreDiarization(ref, hyp, opts);
    expect(s.dominant.get("y")).toEqual({ speaker: "A", ms: 3000, share: 1 });
    expect(s.dominant.get("z")).toEqual({ speaker: "B", ms: 10000, share: 1 });
    expect(s.mapping.has("y")).toBe(false);
  });

  it("reports purity and coverage", () => {
    const ref = [t("A", 0, 10000), t("B", 10000, 20000)];
    const hyp = [t("x", 0, 15000), t("y", 15000, 20000)];
    const s = scoreDiarization(ref, hyp, opts);
    expect(s.purity).toBeCloseTo((10000 + 5000) / 20000);
    expect(s.coverage).toBeCloseTo((10000 + 5000) / 20000);
  });
});

describe("identity error rates", () => {
  it("has zero equal error rate when same and different trials separate", () => {
    const trials = [
      { score: 0.9, same: true },
      { score: 0.8, same: true },
      { score: 0.3, same: false },
      { score: 0.2, same: false },
    ];
    expect(equalErrorRate(trials).eer).toBe(0);
  });

  it("finds the equal error rate where false accepts meet false rejects", () => {
    const trials = [
      { score: 0.9, same: true },
      { score: 0.6, same: true },
      { score: 0.4, same: true },
      { score: 0.7, same: false },
      { score: 0.3, same: false },
      { score: 0.2, same: false },
    ];
    // At 0.5–0.6 one of three same trials is rejected and one of three different trials accepted.
    expect(equalErrorRate(trials).eer).toBeCloseTo(1 / 3);
  });

  it("computes false accept and false reject rates at a threshold", () => {
    const trials = [
      { score: 0.9, same: true },
      { score: 0.5, same: true },
      { score: 0.6, same: false },
      { score: 0.1, same: false },
    ];
    expect(ratesAt(trials, 0.55)).toEqual({ far: 0.5, frr: 0.5 });
  });

  it("picks the lowest threshold that keeps false accepts at or under the target", () => {
    const trials = [
      { score: 0.9, same: true },
      { score: 0.62, same: false },
      { score: 0.5, same: false },
      { score: 0.4, same: false },
      { score: 0.3, same: false },
    ];
    const th = thresholdForFar(trials, 0.25);
    expect(ratesAt(trials, th).far).toBeLessThanOrEqual(0.25);
    expect(th).toBeGreaterThan(0.5);
    expect(th).toBeLessThanOrEqual(0.62 + 1e-9);
  });
});
