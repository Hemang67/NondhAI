import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { buildRender } from "@shared/video/render";
import { emptySpec, splitAt, cutRange, zoomLayout, type ProjectSpec, type ZoomBox } from "@shared/video/project";

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
        zooms: [{ id: "z", rect: { x: 0.5, y: 0.4, w: 0.3, h: 0.25 }, start: 2, end: 6, size: 0.9, blur: 20 }],
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
  it("magnifies the zoom area over a blurred frame, only during the zoom", () => {
    const dir = mkdtempSync(join(tmpdir(), "vd-render-"));
    try {
      const f = (n: string) => join(dir, n);
      // Red frame with a blue square in the top-left corner.
      const src = "color=c=red:s=320x240:rate=15,drawbox=x=16:y=16:w=64:h=48:c=blue:t=fill";
      expect(run(["-y", "-loglevel", "error", "-f", "lavfi", "-i", src, "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", f("in.mp4")]).status).toBe(0);
      const spec: ProjectSpec = {
        ...emptySpec([{ id: "V", startMs: 0, duration: 6 }]),
        meetingAudio: { enabled: false, volume: 1 },
        zooms: [{ id: "z", rect: { x: 0.05, y: 0.066, w: 0.2, h: 0.2 }, start: 2, end: 4, size: 0.9, blur: 10 }],
      };
      const plan = buildRender({
        spec,
        clips: { V: { file: f("in.mp4"), width: 320, height: 240, startMs: 0 } },
        meetingAudio: null,
        font: "C:/Windows/Fonts/segoeui.ttf",
        tmpDir: dir.replace(/\\/g, "/"),
        output: f("out.mp4"),
      });
      const r = run(plan.args);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      // The colour at the centre of the frame at a given time.
      const centre = (at: number) => {
        const px = spawnSync(ff, ["-loglevel", "error", "-ss", String(at), "-i", f("out.mp4"), "-frames:v", "1", "-vf", "crop=2:2:159:119", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
        const [red, , blue] = [...px.stdout.subarray(0, 3)];
        return red! > 150 && blue! < 100 ? "red" : blue! > 150 && red! < 100 ? "blue" : `rgb(${[...px.stdout.subarray(0, 3)]})`;
      };
      expect(centre(1)).toBe("red"); // before: the plain frame
      expect(centre(3)).toBe("blue"); // during: the magnified blue square fills the middle
      expect(centre(5)).toBe("red"); // after: back to the plain frame
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("draws lens and glass zooms in place, over a sharp frame", () => {
    const dir = mkdtempSync(join(tmpdir(), "vd-render-"));
    try {
      const f = (n: string) => join(dir, n);
      // Red 640x360 frame with a blue 80x60 square at (200,150).
      const src = "color=c=red:s=640x360:rate=15,drawbox=x=200:y=150:w=80:h=60:c=blue:t=fill";
      expect(run(["-y", "-loglevel", "error", "-f", "lavfi", "-i", src, "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", f("in.mp4")]).status).toBe(0);
      const area = { x: 200 / 640, y: 150 / 360, w: 80 / 640, h: 60 / 360 };
      const render = (zoom: ZoomBox) => {
        const spec: ProjectSpec = { ...emptySpec([{ id: "V", startMs: 0, duration: 6 }]), meetingAudio: { enabled: false, volume: 1 }, zooms: [zoom] };
        const plan = buildRender({
          spec,
          clips: { V: { file: f("in.mp4"), width: 640, height: 360, startMs: 0 } },
          meetingAudio: null,
          font: "C:/Windows/Fonts/segoeui.ttf",
          tmpDir: dir.replace(/\\/g, "/"),
          output: f(`${zoom.style}.mp4`),
        });
        const r = run(plan.args);
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
        return zoomLayout(zoom, 640, 360);
      };
      const colour = (file: string, at: number, x: number, y: number) => {
        const px = spawnSync(ff, ["-loglevel", "error", "-ss", String(at), "-i", f(file), "-frames:v", "1", "-vf", `format=rgb24,crop=2:2:${Math.round(x)}:${Math.round(y)}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
        const [r, g, b] = [...px.stdout.subarray(0, 3)] as [number, number, number];
        if (r > 200 && g > 200 && b > 200) return "white";
        if (r < 80 && g < 80 && b < 80) return "dark";
        if (r > 150 && b < 100) return "red";
        if (b > 150 && r < 100) return "blue";
        return `rgb(${r},${g},${b})`;
      };
      // A thin frame: true if any pixel in the column x, rows y0..y1, is white.
      const whiteIn = (file: string, at: number, x: number, y0: number, y1: number) => {
        const h = Math.round(y1 - y0) + 1;
        const px = spawnSync(ff, ["-loglevel", "error", "-ss", String(at), "-i", f(file), "-frames:v", "1", "-vf", `format=rgb24,crop=1:${h}:${Math.round(x)}:${Math.round(y0)}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
        for (let i = 0; i + 2 < px.stdout.length; i += 3) if (px.stdout[i]! > 220 && px.stdout[i + 1]! > 220 && px.stdout[i + 2]! > 220) return true;
        return false;
      };

      // Lens, 2x: 160x120 of blue centred where the square was, framed in white.
      const lens = render({ id: "l", style: "lens", rect: area, start: 2, end: 4, size: 0.9, blur: 20, magnify: 2 });
      expect(lens.dst).toMatchObject({ x: 160, y: 120, w: 160, h: 120 });
      expect(colour("lens.mp4", 3, 170, 130)).toBe("blue"); // red in the original, inside the enlarged lens
      expect(whiteIn("lens.mp4", 3, 240, 120 - lens.border - 1, 120)).toBe(true); // the frame
      expect(colour("lens.mp4", 3, 560, 60)).toBe("red"); // the rest stays as it was
      expect(colour("lens.mp4", 5, 170, 130)).toBe("red"); // gone after the zoom

      // Glass, 2x: a circle, its rim white, a dark handle down and to the right.
      const glass = render({ id: "g", style: "glass", rect: area, start: 2, end: 4, size: 0.9, blur: 20, magnify: 2 });
      const { x, y, w } = glass.dst;
      const c = { x: x + w / 2, y: y + w / 2 };
      expect(colour("glass.mp4", 3, c.x, c.y)).toBe("blue");
      expect(colour("glass.mp4", 3, x + 3, y + 3)).toBe("red"); // the square's corner is outside the circle
      expect(whiteIn("glass.mp4", 3, c.x, y - glass.border - 2, y + 1)).toBe(true); // the rim
      const out = w / 2 + glass.border + w * 0.2; // along the handle
      expect(colour("glass.mp4", 3, c.x + out * Math.SQRT1_2 - 1, c.y + out * Math.SQRT1_2 - 1)).toBe("dark");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("renders an imported video with its own soundtrack", () => {
    const dir = mkdtempSync(join(tmpdir(), "vd-render-"));
    try {
      const f = (n: string) => join(dir, n);
      expect(run(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=500", "-t", "5", "-c:v", "libx264", "-c:a", "aac", "-shortest", f("in.mp4")]).status).toBe(0);
      const spec = cutRange(emptySpec([{ id: "V", startMs: 0, duration: 5 }]), 1, 2);
      const plan = buildRender({
        spec,
        clips: { V: { file: f("in.mp4"), width: 320, height: 240, startMs: 0, audio: true } },
        meetingAudio: null,
        font: "C:/Windows/Fonts/segoeui.ttf",
        tmpDir: dir.replace(/\\/g, "/"),
        output: f("out.mp4"),
      });
      const r = run(plan.args);
      expect(r.stderr).toBe("");
      // The output's sound is the video's own tone, not silence.
      const vol = run(["-hide_banner", "-i", f("out.mp4"), "-af", "volumedetect", "-f", "null", "-"]).stderr;
      expect(Number(/mean_volume: (-?[\d.]+) dB/.exec(vol)![1])).toBeGreaterThan(-40);
      const [, h, m, sec] = run(["-hide_banner", "-i", f("out.mp4")]).stderr.match(/Duration: (\d+):(\d+):([\d.]+)/)!;
      expect(Number(h) * 3600 + Number(m) * 60 + Number(sec)).toBeCloseTo(4, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
