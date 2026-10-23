import { describe, expect, it } from "vitest";
import {
  clampRect,
  cutRange,
  deleteSegment,
  duration,
  emptySpec,
  locate,
  moveSegment,
  splitAt,
  subtitlesFromTranscript,
  toSrt,
  type ProjectSpec,
} from "@shared/video/project";
import type { TranscriptLine } from "@shared/meeting/types";

const clips = [
  { id: "A", startMs: 10_000, duration: 20 },
  { id: "B", startMs: 60_000, duration: 10 },
];

const line = (start: number, end: number, text: string, speakerKey = "c0"): TranscriptLine => ({
  id: `${start}`,
  start,
  end,
  text,
  speakerKey,
  channel: "system",
  conf: 0.9,
  overlap: false,
  uncertainSpeaker: false,
});

describe("timeline", () => {
  it("merges clips in order and maps timeline time to source time", () => {
    const s = emptySpec(clips);
    expect(duration(s)).toBe(30);
    expect(locate(s, 5)).toMatchObject({ index: 0, sourceTime: 5 });
    expect(locate(s, 22)).toMatchObject({ index: 1, sourceTime: 2, segmentStart: 20 });
  });

  it("splits at the playhead and ignores splits at boundaries", () => {
    const s = splitAt(emptySpec(clips), 8);
    expect(s.segments.map((x) => [x.clipId, x.in, x.out])).toEqual([
      ["A", 0, 8],
      ["A", 8, 20],
      ["B", 0, 10],
    ]);
    expect(splitAt(s, 8).segments).toHaveLength(3);
  });

  it("cuts a range across segments and shifts timed elements", () => {
    let s: ProjectSpec = emptySpec(clips);
    s = {
      ...s,
      blurs: [
        { id: "b1", start: 2, end: 4, rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, strength: 10 }, // before
        { id: "b2", start: 16, end: 19, rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, strength: 10 }, // inside the cut → dropped
        { id: "b3", start: 25, end: 28, rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, strength: 10 }, // after → shifted
      ],
      texts: [{ id: "t1", start: 10, end: 24, text: "hi", x: 0, y: 0, size: 0.05, color: "#ffffff", background: true }], // spans → shortened
    };
    const out = cutRange(s, 15, 22);
    expect(duration(out)).toBe(23);
    expect(out.segments.map((x) => [x.clipId, x.in, x.out])).toEqual([
      ["A", 0, 15],
      ["B", 2, 10],
    ]);
    expect(out.blurs.map((b) => [b.id, b.start, b.end])).toEqual([
      ["b1", 2, 4],
      ["b3", 18, 21],
    ]);
    expect(out.texts[0]).toMatchObject({ start: 10, end: 17 });
  });

  it("deletes and reorders segments, but never the last one", () => {
    const s = emptySpec(clips);
    expect(deleteSegment(s, 0).segments.map((x) => x.clipId)).toEqual(["B"]);
    expect(deleteSegment(deleteSegment(s, 0), 0).segments).toHaveLength(1);
    expect(moveSegment(s, 0, 1).segments.map((x) => x.clipId)).toEqual(["B", "A"]);
  });
});

describe("subtitles", () => {
  it("takes transcript lines inside kept segments and re-times them to the timeline", () => {
    // Keep A 5–15 s (meeting 15–25 s) then B 0–10 s (meeting 60–70 s).
    const spec = { segments: [ { id: "1", clipId: "A", in: 5, out: 15 }, { id: "2", clipId: "B", in: 0, out: 10 } ] };
    const lines = [
      line(12_000, 14_000, "before the clip part"),
      line(16_000, 19_000, "inside A", "me"),
      line(24_000, 27_000, "crosses the end of A"),
      line(61_000, 63_000, "inside B"),
    ];
    const subs = subtitlesFromTranscript(spec, clips, lines, (k) => (k === "me" ? "Me" : "Priya"));
    expect(subs.map((s) => [s.text, s.start, s.end, s.speaker])).toEqual([
      ["inside A", 1, 4, "Me"],
      ["crosses the end of A", 9, 10, "Priya"],
      ["inside B", 11, 13, "Priya"],
    ]);
  });

  it("writes SRT with speakers", () => {
    expect(toSrt([{ id: "x", start: 1.5, end: 3, text: "Hello", speaker: "Me" }])).toBe("1\n00:00:01,500 --> 00:00:03,000\nMe: Hello\n");
  });
});

describe("clampRect", () => {
  it("keeps rectangles inside the frame", () => {
    expect(clampRect({ x: 0.95, y: -0.1, w: 0.2, h: 0.2 })).toEqual({ x: 0.8, y: 0, w: 0.2, h: 0.2 });
  });
});
