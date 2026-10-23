import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dragRect, fitWithin, regionToVideoCrop } from "@shared/screen";
import { Store } from "../src/main/storage/store";
import { ClipRepo, MeetingRepo } from "../src/main/storage/meetings";

describe("regionToVideoCrop", () => {
  it("scales a region from display DIPs to video pixels (125% scaling)", () => {
    // 1536x864 DIP display captured as a 1920x1080 video
    expect(regionToVideoCrop({ x: 100, y: 50, width: 400, height: 300 }, { width: 1536, height: 864 }, { width: 1920, height: 1080 })).toEqual({
      x: 125,
      y: 63,
      width: 500,
      height: 374,
    });
  });

  it("clamps regions that run off the edge and keeps even sizes", () => {
    const r = regionToVideoCrop({ x: 1500, y: 800, width: 400, height: 400 }, { width: 1536, height: 864 }, { width: 1536, height: 864 });
    expect(r).toEqual({ x: 1500, y: 800, width: 36, height: 64 });
  });

  it("never returns an empty rectangle", () => {
    const r = regionToVideoCrop({ x: 10, y: 10, width: 0, height: 1 }, { width: 100, height: 100 }, { width: 100, height: 100 });
    expect(r.width).toBeGreaterThanOrEqual(2);
    expect(r.height).toBeGreaterThanOrEqual(2);
  });
});

describe("fitWithin and dragRect", () => {
  it("downscales only when needed", () => {
    expect(fitWithin(3840, 2160, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitWithin(801, 601, 1920, 1080)).toEqual({ width: 800, height: 600 });
  });
  it("normalizes drags in any direction", () => {
    expect(dragRect({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 40, height: 60 });
  });
});

describe("ClipRepo", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("stores several start/stop clips per meeting in time order and deletes them with the meeting", () => {
    const dir = mkdtempSync(join(tmpdir(), "vd-clips-"));
    dirs.push(dir);
    const store = new Store(join(dir, "t.db"));
    const meetings = new MeetingRepo(store.db);
    const clips = new ClipRepo(store.db);
    const m = meetings.create({ title: "Demo", kind: "call", dir: "x" });
    const b = clips.create({ meetingId: m.id, kind: "region", label: "Region", startMs: 90000, file: "screen-2.webm" });
    const a = clips.create({ meetingId: m.id, kind: "window", label: "Chrome", startMs: 30000, file: "screen-1.webm" });
    expect(clips.unfinished().map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    clips.finish(a.id, { endMs: 60000, file: "screen-1.webm", width: 1280, height: 720 });
    expect(clips.forMeeting(m.id).map((c) => [c.label, c.endMs])).toEqual([
      ["Chrome", 60000],
      ["Region", null],
    ]);
    expect(clips.unfinished().map((c) => c.id)).toEqual([b.id]);
    meetings.purge(m.id);
    expect(clips.forMeeting(m.id)).toEqual([]);
    store.close();
  });
});
