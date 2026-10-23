import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/storage/store";
import { MeetingRepo } from "../src/main/storage/meetings";
import { VideoProjectRepo } from "../src/main/storage/videoProjects";
import { emptySpec } from "@shared/video/project";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("VideoProjectRepo", () => {
  it("stores, updates and tracks exports; edits go with their meeting", () => {
    const dir = mkdtempSync(join(tmpdir(), "vd-video-"));
    dirs.push(dir);
    const store = new Store(join(dir, "t.db"));
    const meetings = new MeetingRepo(store.db);
    const videos = new VideoProjectRepo(store.db);
    const m = meetings.create({ title: "Standup", kind: "call", dir });
    const spec = emptySpec([{ id: "c1", startMs: 0, duration: 5 }]);
    const p = videos.create({ meetingId: m.id, title: "Demo", spec });
    expect(videos.get(p.id)).toMatchObject({ title: "Demo", exportStatus: "none", spec });

    videos.update(p.id, { title: "  ", spec: { ...spec, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } } });
    expect(videos.get(p.id)).toMatchObject({ title: "Demo", spec: { crop: { w: 0.5 } } });

    videos.setExport(p.id, { status: "rendering" });
    expect(videos.interrupted().map((v) => v.id)).toEqual([p.id]);
    videos.setExport(p.id, { status: "done", file: "edit.mp4" });
    expect(videos.get(p.id)).toMatchObject({ exportStatus: "done", exportFile: "edit.mp4" });
    expect(videos.get(p.id)!.exportedAt).toBeGreaterThan(0);

    meetings.delete(m.id); // soft delete hides the edit
    expect(videos.list()).toEqual([]);
    meetings.purge(m.id); // purge removes it
    expect(videos.get(p.id)).toBeNull();
    store.db.close();
  });
});
