import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { buildRender } from "@shared/video/render";
import { emptySpec, splitAt, cutRange, type ProjectSpec } from "@shared/video/project";

const ff = ffmpegPath as unknown as string;
const run = (args: string[]) => spawnSync(ff, args, { encoding: "utf8" });

/** Real FFmpeg run of a merge that uses every editing feature, on synthetic media. */
describe("render with ffmpeg", () => {
  it("produces a playable MP4 of the edited length", () => {
    const dir = mkdtempSync(join(tmpdir(), "vd-render-"));
    try {
      const f = (n: string) => join(dir, n);
      const gen = (args: string[]) => expect(run(["-y", "-loglevel", "error", ...args]).status).toBe(0);
      gen(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=15", "-t", "6", "-c:v", "libvpx", f("a.webm")]);
      gen(["-f", "lavfi", "-i", "testsrc2=size=466x184:rate=15", "-t", "4", "-c:v", "libvpx", f("b.webm")]);
      gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-c:a", "libopus", f("m.opus")]);
      gen(["-f", "lavfi", "-i", "sine=frequency=880:duration=3", f("x.mp3")]);
      gen(["-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", f("logo.png")]);

      let spec: ProjectSpec = emptySpec([
        { id: "A", startMs: 2000, duration: 6 },
        { id: "B", startMs: 20000, duration: 4 },
      ]);
      spec = cutRange(splitAt(spec, 2), 2, 3); // 10 s → 9 s
      spec = {
        ...spec,
        crop: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
        blurs: [{ id: "b", rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, start: 0, end: 4, strength: 24 }],
        texts: [{ id: "t", text: "Demo: 100% it's fine", x: 0.05, y: 0.05, size: 0.06, color: "#ffcc00", background: true, start: 0, end: 5 }],
        images: [{ id: "i", file: f("logo.png"), x: 0.8, y: 0.05, w: 0.1, start: 1, end: 8 }],
        audioTracks: [{ id: "x", file: f("x.mp3"), start: 1, volume: 0.5 }],
        subtitles: { burnIn: true, exportSrt: false, lines: [{ id: "s", start: 0.5, end: 3, text: "a fairly long subtitle line that should wrap onto two rows", speaker: "Me" }] },
      };
      const plan = buildRender({
        spec,
        clips: {
          A: { file: f("a.webm"), width: 640, height: 360, startMs: 2000 },
          B: { file: f("b.webm"), width: 466, height: 184, startMs: 20000 },
        },
        meetingAudio: f("m.opus"),
        font: "C:/Windows/Fonts/segoeui.ttf",
        tmpDir: dir.replace(/\\/g, "/"),
        output: f("out.mp4"),
      });
      for (const file of plan.files) writeFileSync(file.path, file.content);
      const r = run(plan.args);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(existsSync(f("out.mp4"))).toBe(true);

      // ffmpeg -i prints the container info (exits 1 because no output is given).
      const info = run(["-hide_banner", "-i", f("out.mp4")]).stderr;
      const [, h, m, s] = info.match(/Duration: (\d+):(\d+):([\d.]+)/)!;
      expect(Number(h) * 3600 + Number(m) * 60 + Number(s)).toBeCloseTo(9, 0);
      expect(info).toMatch(/Video: h264.*576x324/);
      expect(info).toMatch(/Audio: aac/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
