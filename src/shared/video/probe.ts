/** What `ffmpeg -i <file>` reports about a media file (first video and audio streams). */
export interface Probe {
  durationMs: number | null;
  video: { codec: string; width: number; height: number; pixFmt: string; rotation: number } | null;
  audio: { codec: string } | null;
}

export function parseProbe(stderr: string): Probe {
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const durationMs = d ? Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000) : null;

  let video: Probe["video"] = null;
  const v = /Stream #\d+:\d+[^:\n]*: Video: (\w+)[^\n]*/.exec(stderr);
  if (v) {
    const line = v[0];
    const size = /, (\d{2,5})x(\d{2,5})[ ,\n]/.exec(line + "\n");
    // Pixel format is the first parenthesis-free token after the codec section, e.g. "yuv420p(tv, ...)".
    const pix = /\b(yuv\w+|yuvj\w+|rgb\w+|bgr\w+|nv12|gray\w*|gbr\w+)\b/.exec(line);
    const rest = stderr.slice(v.index);
    const rot = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(rest.split(/Stream #\d+:\d+[^:\n]*: (?:Audio|Data|Subtitle)/)[0] ?? "");
    if (size) {
      video = {
        codec: v[1]!,
        width: Number(size[1]),
        height: Number(size[2]),
        pixFmt: pix?.[1] ?? "",
        rotation: rot ? ((Math.round(Number(rot[1])) % 360) + 360) % 360 : 0,
      };
    }
  }
  const a = /Stream #\d+:\d+[^:\n]*: Audio: (\w+)/.exec(stderr);
  return { durationMs, video, audio: a ? { codec: a[1]! } : null };
}

/** The size the picture is shown at, after the file's rotation flag. */
export function displaySize(p: Probe): { width: number; height: number } | null {
  if (!p.video) return null;
  const turned = p.video.rotation === 90 || p.video.rotation === 270;
  return turned ? { width: p.video.height, height: p.video.width } : { width: p.video.width, height: p.video.height };
}

export type ImportMode = "mp4" | "webm" | "convert";

/**
 * How to bring a file into the library so the editor's player (Chromium) can play it: keep the
 * streams as they are when it can (only the container is rewritten), otherwise convert to
 * H.264/AAC MP4. 10-bit and 4:4:4 video, HEVC, and old codecs (AVI/WMV/MPEG-2…) are converted.
 */
export function importMode(p: Probe): ImportMode {
  if (!p.video) throw new Error("This file has no video");
  const eightBit420 = /^yuvj?420p$/.test(p.video.pixFmt);
  const a = p.audio?.codec ?? null;
  if (p.video.codec === "h264" && eightBit420 && (a === null || a === "aac" || a === "mp3")) return "mp4";
  if ((p.video.codec === "vp8" || p.video.codec === "vp9") && eightBit420 && (a === null || a === "opus" || a === "vorbis")) return "webm";
  return "convert";
}
