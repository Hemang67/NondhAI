import { describe, expect, it } from "vitest";
import { buildImportedTranscript, parseTime, parseTranscript } from "@shared/meeting/transcriptImport";

const brief = (text: string, file: string) => parseTranscript(text, file).map((t) => [t.start, t.speaker, t.text]);

describe("transcript import", () => {
  it("reads times", () => {
    expect(parseTime("0:05")).toBe(5000);
    expect(parseTime("01:02:03.500")).toBe(3723500);
    expect(parseTime("00:00:01,250")).toBe(1250);
  });

  it("reads Nondh AI's own .txt and .md exports", () => {
    expect(brief("Weekly sync\n10/29/2026\n\n[0:04] Priya: Let's start.\n[1:38] Rahul (speaker uncertain): Good evening", "a.txt")).toEqual([
      [4000, "Priya", "Let's start."],
      [98000, "Rahul", "Good evening"],
    ]);
    expect(brief("# Sync\n\n## Transcript\n\n**Priya** [0:04]: Let's start.\n\n**Speaker 2** [1:38] _(overlap)_: Hi", "a.md")).toEqual([
      [4000, "Priya", "Let's start."],
      [98000, "Speaker 2", "Hi"],
    ]);
  });

  it("reads WebVTT voice tags and joins a speaker's back-to-back cues", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Priya Shah>Hello there</v>\n\n00:00:03.200 --> 00:00:05.000\n<v Priya Shah>and welcome\n\n00:00:06.000 --> 00:00:07.000\nRahul: Thanks";
    const t = parseTranscript(vtt, "x.vtt");
    expect(t.map((x) => [x.start, x.end, x.speaker, x.text])).toEqual([
      [1000, 5000, "Priya Shah", "Hello there and welcome"],
      [6000, 7000, "Rahul", "Thanks"],
    ]);
  });

  it("reads SRT", () => {
    expect(brief("1\n00:00:01,000 --> 00:00:02,000\nPriya: Hi\n\n2\n00:00:02,500 --> 00:00:04,000\nRahul: Hey", "x.srt")).toEqual([
      [1000, "Priya", "Hi"],
      [2500, "Rahul", "Hey"],
    ]);
  });

  it("reads name-and-time headers with the text on the next lines (Otter, Supernormal, Teams)", () => {
    expect(brief("Priya Shah  0:04\nOkay, the updates.\nBoth requests are done.\n\nRahul 1:10\nGreat.", "a.txt")).toEqual([
      [4000, "Priya Shah", "Okay, the updates. Both requests are done."],
      [70000, "Rahul", "Great."],
    ]);
  });

  it("reads Google Meet style: a time line, then named paragraphs", () => {
    expect(brief("Meeting notes\n00:00:00\nPriya: Hi all.\nRahul: Hello.\n00:05:00\nPriya: Next topic.", "meet.txt")).toEqual([
      [0, "Priya", "Hi all."],
      [null, "Rahul", "Hello."],
      [300000, "Priya", "Next topic."],
    ]);
  });

  it("doesn't take ordinary sentences for speakers", () => {
    expect(brief("Priya: The plan is simple.\nso the plan: ship it on Monday\nLet's meet at 5:30", "a.txt")).toEqual([
      [null, "Priya", "The plan is simple. so the plan: ship it on Monday Let's meet at 5:30"],
    ]);
  });

  it("builds lines and speakers, estimating missing times and matching known people", () => {
    const turns = parseTranscript("Hemang: one two three four five\nPriya: six seven\nHemang: eight", "a.txt");
    const r = buildImportedTranscript(turns, (n) => (n === "Hemang" ? { id: "p-me", isMe: true } : null));
    expect(r.speakers).toEqual([
      { key: "me", name: "Me", personId: "p-me", score: null, confidence: "high" },
      { key: "t1", name: "Priya", personId: null, score: null, confidence: "high" },
    ]);
    expect(r.lines.map((l) => [l.speakerKey, l.start, l.end])).toEqual([
      ["me", 0, 2000],
      ["t1", 2000, 3000],
      ["me", 3000, 4000],
    ]);
    expect(r.durationMs).toBe(4000);
  });
});

describe("transcript files", () => {
  it("reads a Word document's paragraphs", async () => {
    const { Document, Packer, Paragraph } = await import("docx");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { readTranscriptFile } = await import("../src/main/meeting/transcriptFiles");
    const doc = new Document({ sections: [{ children: [new Paragraph("Priya Shah  0:04"), new Paragraph("Filters & sources are done.")] }] });
    const file = join(mkdtempSync(join(tmpdir(), "nondh-")), "t.docx");
    writeFileSync(file, await Packer.toBuffer(doc));
    const text = await readTranscriptFile(file);
    expect(brief(text, "t.docx")).toEqual([[4000, "Priya Shah", "Filters & sources are done."]]);
  });
});
