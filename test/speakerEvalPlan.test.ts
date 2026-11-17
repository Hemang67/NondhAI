import { describe, expect, it } from "vitest";
import { planConversation, type PlanSpec } from "../scripts/speaker-eval/plan";

const spec = (over: Partial<PlanSpec> = {}): PlanSpec => ({
  seed: 7,
  speakers: ["a", "b", "c", "d", "e"],
  durationMs: 20 * 60000,
  ackRate: 0.25,
  longRate: 0.1,
  overlapRate: 0.2,
  ...over,
});

describe("planConversation", () => {
  it("is deterministic for a seed", () => {
    expect(planConversation(spec())).toEqual(planConversation(spec()));
    expect(planConversation(spec({ seed: 8 }))).not.toEqual(planConversation(spec()));
  });

  it("fills the requested duration", () => {
    const turns = planConversation(spec());
    const end = Math.max(...turns.map((t) => t.start + t.durMs));
    expect(end).toBeGreaterThanOrEqual(20 * 60000 * 0.95);
    expect(end).toBeLessThan(20 * 60000 + 100000);
  });

  it("lets every speaker talk, starting with a round of introductions", () => {
    const turns = planConversation(spec({ speakers: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] }));
    expect(new Set(turns.slice(0, 10).map((t) => t.speaker)).size).toBe(10);
  });

  it("never gives two consecutive main turns to the same speaker", () => {
    const main = planConversation(spec()).filter((t) => t.kind !== "ack");
    for (let i = 1; i < main.length; i++) expect(main[i]!.speaker).not.toBe(main[i - 1]!.speaker);
  });

  it("makes acknowledgements short and about as common as asked", () => {
    const turns = planConversation(spec());
    const acks = turns.filter((t) => t.kind === "ack");
    for (const a of acks) {
      expect(a.durMs).toBeGreaterThanOrEqual(300);
      expect(a.durMs).toBeLessThanOrEqual(800);
    }
    expect(acks.length / turns.length).toBeGreaterThan(0.15);
    expect(acks.length / turns.length).toBeLessThan(0.35);
  });

  it("starts about the requested share of main turns before the previous one ends", () => {
    const main = planConversation(spec()).filter((t) => t.kind !== "ack");
    let overlapping = 0;
    for (let i = 1; i < main.length; i++) if (main[i]!.start < main[i - 1]!.start + main[i - 1]!.durMs) overlapping++;
    const share = overlapping / (main.length - 1);
    expect(share).toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.3);
  });

  it("has no overlap when none is asked for", () => {
    const turns = planConversation(spec({ overlapRate: 0, ackRate: 0 }));
    for (let i = 1; i < turns.length; i++) expect(turns[i]!.start).toBeGreaterThanOrEqual(turns[i - 1]!.start + turns[i - 1]!.durMs);
  });
});
