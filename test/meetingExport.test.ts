import { describe, expect, it } from "vitest";
import { clock, toMarkdown, toSrt, toText, toVtt, transcriptForLlm } from "@shared/meeting/export";
import { chunkTranscript, mergeSummaries, parseSummary } from "@shared/meeting/summary";
import type { TranscriptLine } from "@shared/meeting/types";

const line = (speakerKey: string, start: number, end: number, text: string, extra: Partial<TranscriptLine> = {}): TranscriptLine => ({
  id: `${speakerKey}${start}`,
  start,
  end,
  speakerKey,
  channel: speakerKey === "me" ? "mic" : "system",
  text,
  conf: 0.9,
  overlap: false,
  uncertainSpeaker: false,
  ...extra,
});

const input = {
  title: "Pricing sync",
  startedAt: Date.UTC(2026, 9, 23, 10, 0, 0),
  durationMs: 125000,
  lines: [
    line("c0", 0, 2500, "Let's start with pricing."),
    line("c0", 2600, 4000, "The deck is ready."),
    line("me", 4200, 6000, "Great, ship it.", { overlap: true }),
    line("c1", 6100, 21000, "one two three four five six seven eight nine ten eleven twelve"),
  ],
  speakers: { c0: { name: "Priya" }, me: { name: "Me" }, c1: { name: "Speaker 2" } },
};

describe("exports", () => {
  it("formats clock times", () => {
    expect(clock(65000)).toBe("1:05");
    expect(clock(3725000)).toBe("1:02:05");
  });

  it("merges consecutive lines of one speaker in Markdown and flags overlap", () => {
    const md = toMarkdown(input);
    expect(md).toContain("# Pricing sync");
    expect(md).toContain("**Priya** [0:00]: Let's start with pricing. The deck is ready.");
    expect(md).toContain("**Me** [0:04] _(overlapping speech)_: Great, ship it.");
  });

  it("produces plain text with timestamps", () => {
    expect(toText(input)).toContain("[0:04] Me (overlapping speech): Great, ship it.");
  });

  it("produces valid SRT with comma milliseconds and splits long cues", () => {
    const srt = toSrt(input);
    expect(srt.startsWith("1\n00:00:00,000 --> 00:00:02,500\nPriya: Let's start with pricing.\n")).toBe(true);
    const c1 = srt.split("\n\n").filter((b) => b.includes("Speaker 2:"));
    expect(c1.length).toBe(3); // 14.9 s → three cues of ≤ 7 s
  });

  it("produces WebVTT with dot milliseconds", () => {
    const vtt = toVtt(input);
    expect(vtt.startsWith("WEBVTT\n\n00:00:00.000 --> 00:00:02.500\n")).toBe(true);
  });

  it("renders an LLM-friendly transcript", () => {
    expect(transcriptForLlm(input).split("\n")[0]).toBe("[0:00] Priya: Let's start with pricing. The deck is ready.");
  });
});

describe("summary parsing", () => {
  it("parses JSON wrapped in prose and fences", () => {
    const s = parseSummary('Here you go:\n```json\n{"keyPoints":["A"],"decisions":[],"actionItems":[{"task":"Send deck","owner":"Priya","due":null}],"openQuestions":["Q?"]}\n```');
    expect(s).toEqual({ keyPoints: ["A"], decisions: [], actionItems: [{ task: "Send deck", owner: "Priya", due: null }], openQuestions: ["Q?"] });
  });

  it("tolerates string action items and missing fields", () => {
    expect(parseSummary('{"actionItems":["Call vendor"]}')).toEqual({
      keyPoints: [],
      decisions: [],
      actionItems: [{ task: "Call vendor", owner: null, due: null }],
      openQuestions: [],
    });
  });

  it("returns null for non-JSON", () => {
    expect(parseSummary("I could not summarize this.")).toBeNull();
  });

  it("chunks transcripts by lines and merges partial summaries", () => {
    expect(chunkTranscript("aaa\nbbb\nccc", 8)).toEqual(["aaa\nbbb", "ccc"]);
    const m = mergeSummaries([
      { keyPoints: ["x"], decisions: ["d"], actionItems: [], openQuestions: [] },
      { keyPoints: ["x", "y"], decisions: [], actionItems: [{ task: "t", owner: null, due: null }], openQuestions: [] },
    ]);
    expect(m.keyPoints).toEqual(["x", "y"]);
    expect(m.actionItems).toHaveLength(1);
  });
});
