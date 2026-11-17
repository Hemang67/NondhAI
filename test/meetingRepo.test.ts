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

  it("lists speakers with me first, then in the order they first speak", () => {
    const { store, meetings } = open();
    const m = meetings.create({ title: "x", kind: "call", dir: "x" });
    const sp = (key: string) => ({ key, name: key, personId: null, score: null, confidence: "low" as const });
    meetings.setSpeakers(m.id, [sp("c0"), sp("c10"), sp("c2"), sp("me"), sp("c5")]);
    meetings.replaceLines(m.id, [line("1", 0, "c2", "a"), line("2", 1000, "c10", "b"), line("3", 2000, "me", "c"), line("4", 5000, "c0", "d")], true);
    // c5 has no lines (yet): it goes last.
    expect(meetings.speakers(m.id).map((s) => s.key)).toEqual(["me", "c2", "c10", "c0", "c5"]);
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

  it("keeps a person's best meeting voiceprints by quality, not just the newest", () => {
    const { store, people } = open();
    const p = people.create("Priya");
    for (let i = 0; i < 4; i++) people.addVoiceprint(p.id, [1, i], "titanet", "meeting", undefined, { quality: 0.9, speechMs: 40000 });
    for (let i = 0; i < 8; i++) people.addVoiceprint(p.id, [0, i], "titanet", "meeting", undefined, { quality: 0.2, speechMs: 6000 });
    const v = people.voices("titanet")[0]!;
    expect(v.embeddings).toHaveLength(8);
    expect(v.qualities.filter((q) => q === 0.9)).toHaveLength(4);
    store.close();
  });

  it("reads voiceprints saved before quality existed as medium quality", () => {
    const { store, people } = open();
    const p = people.create("Mark");
    people.addVoiceprint(p.id, [1, 0], "titanet", "meeting");
    expect(people.voices("titanet")[0]!.qualities).toEqual([0.5]);
    store.close();
  });
});

describe("re-deriving voices for a new model", () => {
  it("finds named speakers whose voice was made by another model, in meetings that kept their audio", () => {
    const { store, meetings } = open();
    const withAudio = meetings.create({ title: "a", kind: "call", dir: "x" });
    meetings.update(withAudio.id, { audioFile: "audio.opus" });
    const noAudio = meetings.create({ title: "b", kind: "call", dir: "y" });
    const named = (key: string, model: string | null) => ({ key, name: "Priya", personId: "p1", score: null, confidence: "high" as const, embedding: [1], model, confirmed: true });
    // Only diarized speakers qualify: imported-transcript ("t0") and "others" lines aren't one voice we can trust.
    meetings.setSpeakers(withAudio.id, [named("c0", null), named("c1", "titanet"), { ...named("c2", null), confirmed: false, personId: null }, named("t0", null), named("others", null)]);
    meetings.setSpeakers(noAudio.id, [named("c0", null)]);
    expect(meetings.namedSpeakersNeedingVoice("titanet")).toEqual([{ meetingId: withAudio.id, key: "c0", personId: "p1" }]);
    store.close();
  });

  it("replaces a meeting speaker's voice and evidence", () => {
    const { store, meetings } = open();
    const m = meetings.create({ title: "a", kind: "call", dir: "x" });
    meetings.setSpeakers(m.id, [{ key: "c0", name: "Priya", personId: "p1", score: null, confidence: "high", embedding: [1, 0] }]);
    meetings.setSpeakerVoice(m.id, "c0", { embedding: [0, 1], cleanMs: 30000, cohesion: 0.9, model: "titanet" });
    expect(meetings.speakers(m.id)[0]).toMatchObject({ cleanMs: 30000, model: "titanet", name: "Priya" });
    expect(Array.from(meetings.speakers(m.id)[0]!.embedding!)).toEqual([0, 1]);
    store.close();
  });

  it("counts a person's voice samples for the model in use only", () => {
    const { store, people } = open();
    const p = people.create("Priya");
    people.addVoiceprint(p.id, [1], "campplus-v1", "meeting");
    people.addVoiceprint(p.id, [1], "titanet", "meeting");
    expect(people.list("titanet").find((x) => x.id === p.id)!.voiceprints).toBe(1);
    store.close();
  });
});

describe("MeetingRepo.mergeSpeakers", () => {
  it("moves every line of one speaker to another and removes the merged speaker", () => {
    const { store, meetings } = open();
    const m = meetings.create({ title: "x", kind: "call", dir: "x" });
    const sp = (key: string, name: string) => ({ key, name, personId: null, score: null, confidence: "low" as const });
    meetings.setSpeakers(m.id, [sp("c0", "Speaker 1"), sp("c3", "Speaker 2"), sp("me", "Me")]);
    meetings.replaceLines(m.id, [line("1", 0, "c0", "a"), line("2", 1000, "c3", "b"), line("3", 2000, "c3", "c"), line("4", 3000, "me", "d")], true);
    meetings.mergeSpeakers(m.id, "c3", "c0");
    expect(meetings.lines(m.id).map((l) => l.speakerKey)).toEqual(["c0", "c0", "c0", "me"]);
    expect(meetings.speakers(m.id).map((s) => s.key)).toEqual(["me", "c0"]);
    store.close();
  });

  it("refuses to merge a speaker into itself or into a speaker that doesn't exist", () => {
    const { store, meetings } = open();
    const m = meetings.create({ title: "x", kind: "call", dir: "x" });
    meetings.setSpeakers(m.id, [{ key: "c0", name: "Speaker 1", personId: null, score: null, confidence: "low" }]);
    expect(() => meetings.mergeSpeakers(m.id, "c0", "c0")).toThrow(/itself/);
    expect(() => meetings.mergeSpeakers(m.id, "c0", "c9")).toThrow(/not found/);
    store.close();
  });
});

describe("MeetingRepo speaker evidence", () => {
  it("stores how much clear speech backs each speaker, and the model of its embedding", () => {
    const { store, meetings } = open();
    const m = meetings.create({ title: "x", kind: "call", dir: "x" });
    meetings.setSpeakers(m.id, [
      { key: "c0", name: "Speaker 1", personId: null, score: 0.4, confidence: "low", embedding: [0.1], cleanMs: 42000, cohesion: 0.81, margin: 0.3, model: "titanet" },
      { key: "c1", name: "Speaker 2", personId: null, score: null, confidence: "low", embedding: [0.2] },
    ]);
    const [a, b] = meetings.speakers(m.id).sort((x, y) => x.key.localeCompare(y.key));
    expect(a).toMatchObject({ cleanMs: 42000, margin: 0.3, model: "titanet" });
    expect(a!.cohesion).toBeCloseTo(0.81);
    expect(b).toMatchObject({ cleanMs: null, cohesion: null, margin: null, model: null });
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
