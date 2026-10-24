import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/storage/store";
import { MeetingRepo, PeopleRepo } from "../src/main/storage/meetings";
import type { TranscriptLine } from "@shared/meeting/types";

const dirs: string[] = [];
function open() {
  const dir = mkdtempSync(join(tmpdir(), "vd-meet-"));
  dirs.push(dir);
  const store = new Store(join(dir, "t.db"));
  return { store, meetings: new MeetingRepo(store.db), people: new PeopleRepo(store.db) };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const line = (id: string, start: number, speakerKey: string, text: string): TranscriptLine => ({
  id,
  start,
  end: start + 1000,
  speakerKey,
  channel: speakerKey === "me" ? "mic" : "system",
  text,
  conf: 0.9,
  overlap: false,
  uncertainSpeaker: false,
});

describe("MeetingRepo", () => {
  it("creates, updates and lists meetings, newest first", () => {
    const { store, meetings } = open();
    const a = meetings.create({ title: "A", kind: "call", dir: "x", startedAt: 1000 });
    meetings.create({ title: "B", kind: "room", dir: "y", startedAt: 2000 });
    meetings.update(a.id, { status: "ready", durationMs: 5000, summary: { keyPoints: ["k"], decisions: [], actionItems: [], openQuestions: [] } });
    expect(meetings.list().map((m) => m.title)).toEqual(["B", "A"]);
    expect(meetings.get(a.id)).toMatchObject({ status: "ready", durationMs: 5000, summary: { keyPoints: ["k"] } });
    store.close();
  });

  it("stores transcript lines and finds meetings by spoken words", () => {
    const { store, meetings } = open();
    const m = meetings.create({ title: "Weekly", kind: "call", dir: "x" });
    meetings.replaceLines(m.id, [line("1", 0, "c0", "the pricing model is too complex"), line("2", 2000, "me", "agreed")], true);
    expect(meetings.lines(m.id).map((l) => l.text)).toEqual(["the pricing model is too complex", "agreed"]);
    expect(meetings.list({ query: "pricing" }).map((x) => x.id)).toEqual([m.id]);
    expect(meetings.searchLines("pricing complex")[0]).toMatchObject({ meetingId: m.id, title: "Weekly" });
    // replacing lines (final pass) drops the live ones
    meetings.replaceLines(m.id, [line("9", 0, "c0", "final text")], true);
    expect(meetings.lines(m.id)).toHaveLength(1);
    expect(meetings.list({ query: "pricing" })).toHaveLength(0);
    store.close();
  });

  it("renames speakers and moves a line to another speaker", () => {
    const { store, meetings } = open();
    const m = meetings.create({ title: "x", kind: "call", dir: "x" });
    meetings.setSpeakers(m.id, [
      { key: "c0", name: "Speaker 1", personId: null, score: null, confidence: "low", embedding: [0.1, 0.2] },
      { key: "me", name: "Me", personId: null, score: null, confidence: "high" },
    ]);
    meetings.replaceLines(m.id, [line("1", 0, "c0", "hi")], true);
    meetings.renameSpeaker(m.id, "c0", "Priya", "p1");
    meetings.setLineSpeaker(m.id, "1", "me");
    const sp = meetings.speakers(m.id).find((s) => s.key === "c0")!;
    expect(sp).toMatchObject({ name: "Priya", personId: "p1", confirmed: true, confidence: "high" });
    expect(Array.from(sp.embedding!)).toEqual([Math.fround(0.1), Math.fround(0.2)]);
    expect(meetings.lines(m.id)[0]!.speakerKey).toBe("me");
    store.close();
  });
});

describe("PeopleRepo", () => {
  it("keeps voiceprints per person and caps meeting-derived ones", () => {
    const { store, people } = open();
    const me = people.create("Hemang", true);
    const p = people.create("Priya");
    people.addVoiceprint(me.id, [1, 0], "campplus", "enrollment");
    for (let i = 0; i < 12; i++) people.addVoiceprint(p.id, [0, i], "campplus", "meeting");
    const voices = people.voices("campplus");
    expect(voices.find((v) => v.personId === me.id)!.isMe).toBe(true);
    expect(voices.find((v) => v.personId === p.id)!.embeddings).toHaveLength(8);
    expect(people.me()!.name).toBe("Hemang");
    expect(people.findByName("priya")!.id).toBe(p.id);
    people.delete(p.id);
    expect(people.voices("campplus")).toHaveLength(1);
    store.close();
  });
});

describe("MeetingRepo.inRange", () => {
  it("returns meetings started in the range, oldest first, without deleted ones", () => {
    const { store, meetings } = open();
    const at = (d: number) => new Date(2026, 9, d, 10).getTime();
    meetings.create({ id: "a", title: "A", kind: "call", dir: "x", startedAt: at(20) });
    meetings.create({ id: "b", title: "B", kind: "call", dir: "x", startedAt: at(5) });
    meetings.create({ id: "c", title: "C", kind: "call", dir: "x", startedAt: at(31) + 86400000 }); // 1 Nov
    meetings.create({ id: "d", title: "D", kind: "call", dir: "x", startedAt: at(12) });
    meetings.delete("d");
    expect(meetings.inRange(new Date(2026, 9, 1).getTime(), new Date(2026, 10, 1).getTime()).map((m) => m.id)).toEqual(["b", "a"]);
    store.close();
  });
});
