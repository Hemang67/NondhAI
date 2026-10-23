import { describe, expect, it } from "vitest";
import { buildRender, filterPath, parseProgress, wrap } from "@shared/video/render";
import { emptySpec, splitAt, type ProjectSpec } from "@shared/video/project";

const clipsMeta = {
  A: { file: "D:\\m\\screen-1.webm", width: 1920, height: 1080, startMs: 12000 },
  B: { file: "D:\\m\\screen-2.webm", width: 932, height: 366, startMs: 60000 },
};
const base = (spec: ProjectSpec) => ({
  spec,
  clips: clipsMeta,
  meetingAudio: "D:\\m\\audio.opus",
  font: "C:\\Windows\\Fonts\\segoeui.ttf",
  tmpDir: "C:/tmp/vd",
  output: "D:\\out.mp4",
});
const graphOf = (p: { args: string[] }) => p.args[p.args.indexOf("-filter_complex") + 1]!;

describe("buildRender", () => {
  it("merges clips, scales them to the first clip's frame, and trims matching meeting audio", () => {
    const spec = emptySpec([
      { id: "A", startMs: 12000, duration: 20 },
      { id: "B", startMs: 60000, duration: 10 },
    ]);
    const p = buildRender(base(spec));
    const g = graphOf(p);
    expect(p.args.filter((a) => a === "-i")).toHaveLength(3); // two clips + meeting audio
    expect(g).toContain("[0:v]trim=start=0:end=20");
    expect(g).toContain("[1:v]trim=start=0:end=10");
    expect(g).toContain("scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080");
    expect(g).toContain("[2:a]atrim=start=12:end=32"); // clip A starts 12 s into the meeting
    expect(g).toContain("[2:a]atrim=start=60:end=70");
    expect(g).toContain("concat=n=2:v=1:a=1[vc][ac]");
    expect(p.duration).toBe(30);
    expect(p.args.at(-1)).toBe("D:\\out.mp4");
  });

  it("reuses one input when a clip is split into several segments", () => {
    const spec = splitAt(emptySpec([{ id: "A", startMs: 0, duration: 20 }]), 5);
    expect(buildRender(base(spec)).args.filter((a) => a === "-i")).toHaveLength(2);
  });

  it("uses silence when meeting audio is off", () => {
    const spec = { ...emptySpec([{ id: "A", startMs: 0, duration: 4 }]), meetingAudio: { enabled: false, volume: 1 } };
    expect(graphOf(buildRender(base(spec)))).toContain("aevalsrc=0|0:s=48000:d=4[a0]");
  });

  it("crops, then applies blurs relative to the cropped frame, limited in time", () => {
    const spec: ProjectSpec = {
      ...emptySpec([{ id: "A", startMs: 0, duration: 10 }]),
      crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
      blurs: [{ id: "b", rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, start: 2, end: 5, strength: 20 }],
    };
    const p = buildRender(base(spec));
    const g = graphOf(p);
    expect(g).toContain("[vc]crop=960:540:960:540[vk]");
    expect(g).toContain("crop=480:270:0:0,boxblur=20:2:10:2");
    expect(g).toContain("overlay=0:0:enable='between(t,2,5)'");
    expect([p.width, p.height]).toEqual([960, 540]);
  });

  it("leaves out blur suggestions that were not accepted", () => {
    const box = { rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, start: 0, end: 2, strength: 10 };
    const spec: ProjectSpec = {
      ...emptySpec([{ id: "A", startMs: 0, duration: 10 }]),
      blurs: [{ ...box, id: "ok" }, { ...box, id: "maybe", suggested: { reason: "token", text: "x" } }],
    };
    expect(graphOf(buildRender(base(spec))).match(/boxblur/g)).toHaveLength(1);
  });

  it("writes text and subtitles to files and burns them in with drawtext", () => {
    const spec: ProjectSpec = {
      ...emptySpec([{ id: "A", startMs: 0, duration: 10 }]),
      texts: [{ id: "t", text: "Don't: share 50%", x: 0.1, y: 0.1, size: 0.05, color: "#ffcc00", background: true, start: 0, end: 3 }],
      subtitles: { burnIn: true, exportSrt: true, lines: [{ id: "s", start: 1, end: 2, text: "hello there", speaker: "Priya" }] },
    };
    const p = buildRender(base(spec));
    expect(p.files).toEqual([
      { path: "C:/tmp/vd/text-0.txt", content: "Don't: share 50%" },
      { path: "C:/tmp/vd/sub-0.txt", content: "Priya: hello there" },
    ]);
    const g = graphOf(p);
    expect(g).toContain("textfile='C\\:/tmp/vd/text-0.txt'");
    expect(g).toContain("fontcolor=#ffcc00");
    expect(g).toContain("enable='between(t,1,2)'");
  });

  it("mixes added audio tracks at their start time", () => {
    const spec: ProjectSpec = { ...emptySpec([{ id: "A", startMs: 0, duration: 10 }]), audioTracks: [{ id: "x", file: "D:\\music.mp3", start: 2.5, volume: 0.4 }] };
    const g = graphOf(buildRender(base(spec)));
    expect(g).toContain("adelay=2500|2500,volume=0.4[x0]");
    expect(g).toContain("[ac][x0]amix=inputs=2:duration=first");
  });

  it("refuses an empty timeline", () => {
    expect(() => buildRender(base({ ...emptySpec([]) }))).toThrow(/empty/);
  });
});

describe("helpers", () => {
  it("escapes Windows paths for filter graphs", () => {
    expect(filterPath("C:\\Users\\me\\a'b.txt")).toBe("'C\\:/Users/me/a\\'b.txt'");
  });
  it("wraps long subtitle lines", () => {
    expect(wrap("one two three four five", 9)).toBe("one two\nthree\nfour five");
  });
  it("parses ffmpeg progress", () => {
    expect(parseProgress("frame=10\nout_time_us=1500000\nprogress=continue\n")).toBe(1.5);
    expect(parseProgress("frame=1\n")).toBeNull();
  });
});
