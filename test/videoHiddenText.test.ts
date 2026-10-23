import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { hiddenText } from "@shared/video/sensitive";

const W = 960;
const H = 540;
const font = "C\\:/Windows/Fonts/segoeui.ttf";
const text = (s: string, y: number) => `drawtext=fontfile='${font}':text='${s}':x=48:y=${y}:fontsize=30:fontcolor=0x1f2937`;

/** Renders a frame with ffmpeg and returns it as 8-bit gray pixels. */
function frame(filters: string[], base = "color=c=0xf8fafc"): Uint8Array {
  const r = spawnSync(
    ffmpegPath as unknown as string,
    ["-v", "error", "-f", "lavfi", "-i", `${base}:s=${W}x${H}`, "-frames:v", "1", "-vf", [...filters, "format=gray"].join(","), "-f", "rawvideo", "-"],
    { maxBuffer: 1 << 24 },
  );
  expect(r.status).toBe(0);
  return new Uint8Array(r.stdout);
}

describe("hiddenText (lines Windows OCR withholds)", () => {
  it("flags a text line no OCR word covers, and nothing that OCR read or that isn't text", () => {
    const gray = frame([
      text("Admin password\\: Sunset-Lake-42", 120),
      text("Card number\\: 4111 1111 1111 1111", 200),
      // A picture: big shapes, not text.
      "drawbox=x=600:y=300:w=280:h=180:color=0x0284c7:t=fill",
      "drawbox=x=640:y=340:w=60:h=60:color=0xffffff:t=fill",
    ]);
    // OCR read the password line (one box covering it), and nothing else.
    const read = [{ x: 46, y: 118, w: 470, h: 42 }];
    const hits = hiddenText(gray, W, H, read);
    expect(hits).toHaveLength(1);
    const r = hits[0]!;
    // The card line's glyphs sit at y≈206-227 px and start at x≈48.
    expect(r.y * H).toBeLessThan(205);
    expect((r.y + r.h) * H).toBeGreaterThan(228);
    expect(r.x * W).toBeLessThan(50);
    expect(r.w * W).toBeGreaterThan(400);
  });

  it("finds nothing when OCR read every line", () => {
    const gray = frame([text("Plan\\: Team (annual)", 120), text("Seats\\: 48", 200)]);
    expect(hiddenText(gray, W, H, [{ x: 46, y: 118, w: 320, h: 42 }, { x: 46, y: 198, w: 160, h: 42 }])).toEqual([]);
  });

  it("works on dark backgrounds too", () => {
    const gray = frame([text("Card number\\: 4111 1111 1111 1111", 200).replace("0x1f2937", "0xe5e7eb")], "color=c=0x111827");
    expect(hiddenText(gray, W, H, [])).toHaveLength(1);
  });
});
