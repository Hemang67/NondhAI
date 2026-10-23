import type { NRect, ProjectSpec } from "./project";
import { segLen } from "./project";

export interface RenderInput {
  spec: ProjectSpec;
  /**
   * Readable (decrypted) video file and size for every clip the timeline uses. `audio` marks a
   * clip with its own soundtrack (an imported video), used when there is no meeting audio.
   */
  clips: Record<string, { file: string; width: number; height: number; startMs: number; audio?: boolean }>;
  /** The meeting recording, if there is one (used when meetingAudio is enabled). */
  meetingAudio: string | null;
  /** Absolute path of a font file for text and subtitles. */
  font: string;
  /** Where to put the small text files drawtext reads (avoids escaping user text). */
  tmpDir: string;
  output: string;
  fps?: number;
}

export interface RenderPlan {
  args: string[];
  /** Files the caller must write before running FFmpeg. */
  files: Array<{ path: string; content: string }>;
  width: number;
  height: number;
  duration: number;
}

const even = (v: number) => Math.max(2, Math.round(v) - (Math.round(v) % 2));
const num = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** Paths inside a filter graph: forward slashes, escaped drive colon, single-quoted. */
export function filterPath(p: string): string {
  return `'${p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'")}'`;
}

function px(r: NRect, w: number, h: number) {
  const x = Math.max(0, Math.round(r.x * w));
  const y = Math.max(0, Math.round(r.y * h));
  return { x, y, w: Math.min(w - x, even(r.w * w)), h: Math.min(h - y, even(r.h * h)) };
}

/** Wrap subtitle text so long lines stay on screen (~charsPerLine per row). */
export function wrap(text: string, charsPerLine: number): string {
  const words = text.trim().split(/\s+/);
  const rows: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > charsPerLine) {
      rows.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) rows.push(cur);
  return rows.join("\n");
}

/**
 * One FFmpeg run for the whole edit: each kept segment is trimmed from its clip (with the
 * matching stretch of meeting audio), scaled to a common frame, concatenated, then cropped,
 * blurred, overlaid and subtitled, and mixed with any added audio tracks.
 */
export function buildRender(i: RenderInput): RenderPlan {
  const { spec } = i;
  const fps = i.fps ?? 15;
  if (!spec.segments.length) throw new Error("Nothing to export: the timeline is empty");
  const first = i.clips[spec.segments[0]!.clipId];
  if (!first) throw new Error("A clip used in this edit is missing");
  const baseW = even(first.width);
  const baseH = even(first.height);

  const args = ["-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats"];
  const files: RenderPlan["files"] = [];
  const graph: string[] = [];

  // Inputs: clips (once each), meeting audio, images, added audio tracks.
  const clipInput = new Map<string, number>();
  let n = 0;
  for (const s of spec.segments) {
    const c = i.clips[s.clipId];
    if (!c) throw new Error("A clip used in this edit is missing");
    if (!clipInput.has(s.clipId)) {
      args.push("-i", c.file);
      clipInput.set(s.clipId, n++);
    }
  }
  const useMeetingAudio = spec.meetingAudio.enabled && !!i.meetingAudio;
  const meetingIn = useMeetingAudio ? n++ : -1;
  if (useMeetingAudio) args.push("-i", i.meetingAudio!);
  const imageIn = spec.images.map((img) => {
    args.push("-loop", "1", "-i", img.file);
    return n++;
  });
  const trackIn = spec.audioTracks.map((t) => {
    args.push("-i", t.file);
    return n++;
  });

  // Segments → common frame + matching audio.
  const total = spec.segments.reduce((t, s) => t + segLen(s), 0);
  spec.segments.forEach((s, k) => {
    const c = i.clips[s.clipId]!;
    const vin = clipInput.get(s.clipId)!;
    graph.push(
      // tpad + trim pin each segment to its exact length (holding the last frame if the file is
      // a little short), so later segments stay in step with their audio.
      `[${vin}:v]trim=start=${num(s.in)}:end=${num(s.out)},setpts=PTS-STARTPTS,fps=${fps},` +
        `tpad=stop_mode=clone:stop_duration=${num(segLen(s))},trim=duration=${num(segLen(s))},` +
        `scale=${baseW}:${baseH}:force_original_aspect_ratio=decrease,pad=${baseW}:${baseH}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${k}]`,
    );
    if (useMeetingAudio) {
      const a0 = c.startMs / 1000 + s.in;
      graph.push(
        `[${meetingIn}:a]atrim=start=${num(a0)}:end=${num(a0 + segLen(s))},asetpts=PTS-STARTPTS,` +
          `aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${num(segLen(s))},volume=${num(spec.meetingAudio.volume)}[a${k}]`,
      );
    } else if (spec.meetingAudio.enabled && c.audio) {
      graph.push(
        `[${vin}:a]atrim=start=${num(s.in)}:end=${num(s.out)},asetpts=PTS-STARTPTS,` +
          `aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${num(segLen(s))},volume=${num(spec.meetingAudio.volume)}[a${k}]`,
      );
    } else {
      graph.push(`aevalsrc=0|0:s=48000:d=${num(segLen(s))}[a${k}]`);
    }
  });
  graph.push(`${spec.segments.map((_, k) => `[v${k}][a${k}]`).join("")}concat=n=${spec.segments.length}:v=1:a=1[vc][ac]`);

  // Crop.
  let cur = "vc";
  let W = baseW;
  let H = baseH;
  if (spec.crop) {
    const c = px(spec.crop, baseW, baseH);
    graph.push(`[vc]crop=${c.w}:${c.h}:${c.x}:${c.y}[vk]`);
    cur = "vk";
    W = c.w;
    H = c.h;
  }

  // Blurs (each limited to its rectangle and time range). Suggestions the user hasn't
  // accepted yet are not applied.
  spec.blurs.forEach((b, k) => {
    if (b.suggested) return;
    const r = px(b.rect, W, H);
    if (r.w < 4 || r.h < 4) return;
    // Radii are capped by the plane size; chroma planes are half size in yuv420p.
    const side = Math.min(r.w, r.h);
    const radius = Math.max(1, Math.min(Math.round(b.strength), Math.floor(side / 2) - 1));
    const chroma = Math.max(1, Math.min(Math.ceil(radius / 2), Math.floor(side / 4) - 1));
    graph.push(
      `[${cur}]split[bm${k}][bs${k}];[bs${k}]crop=${r.w}:${r.h}:${r.x}:${r.y},boxblur=${radius}:2:${chroma}:2[bb${k}];` +
        `[bm${k}][bb${k}]overlay=${r.x}:${r.y}:enable='between(t,${num(b.start)},${num(b.end)})'[vb${k}]`,
    );
    cur = `vb${k}`;
  });

  // Images.
  spec.images.forEach((img, k) => {
    const w = even(img.w * W);
    graph.push(
      `[${imageIn[k]}:v]scale=${w}:-2,format=rgba[im${k}];` +
        `[${cur}][im${k}]overlay=${Math.round(img.x * W)}:${Math.round(img.y * H)}:enable='between(t,${num(img.start)},${num(img.end)})':shortest=1[vi${k}]`,
    );
    cur = `vi${k}`;
  });

  // Text elements and subtitles via drawtext (text read from files, so nothing needs escaping).
  const draws: string[] = [];
  const font = filterPath(i.font);
  spec.texts.forEach((t, k) => {
    const path = `${i.tmpDir}/text-${k}.txt`;
    files.push({ path, content: t.text });
    const size = Math.max(8, Math.round(t.size * H));
    draws.push(
      `drawtext=fontfile=${font}:textfile=${filterPath(path)}:expansion=none:fontsize=${size}:fontcolor=${t.color}:` +
        `x=${Math.round(t.x * W)}:y=${Math.round(t.y * H)}` +
        (t.background ? `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(size * 0.3)}` : "") +
        `:enable='between(t,${num(t.start)},${num(t.end)})'`,
    );
  });
  if (spec.subtitles.burnIn) {
    const size = Math.max(12, Math.round(H * 0.045));
    const perLine = Math.max(20, Math.floor(W / (size * 0.55)));
    spec.subtitles.lines.forEach((l, k) => {
      if (!l.text.trim()) return;
      const path = `${i.tmpDir}/sub-${k}.txt`;
      files.push({ path, content: wrap(l.speaker ? `${l.speaker}: ${l.text}` : l.text, perLine) });
      draws.push(
        `drawtext=fontfile=${font}:textfile=${filterPath(path)}:expansion=none:fontsize=${size}:fontcolor=white:line_spacing=${Math.round(size * 0.25)}:` +
          `x=(w-text_w)/2:y=h-text_h-${Math.round(H * 0.06)}:box=1:boxcolor=black@0.6:boxborderw=${Math.round(size * 0.35)}:` +
          `enable='between(t,${num(l.start)},${num(l.end)})'`,
      );
    });
  }
  if (draws.length) {
    graph.push(`[${cur}]${draws.join(",")}[vt]`);
    cur = "vt";
  }
  graph.push(`[${cur}]format=yuv420p[vout]`);

  // Added audio tracks mixed over the meeting audio.
  if (spec.audioTracks.length) {
    spec.audioTracks.forEach((t, k) => {
      const d = Math.round(t.start * 1000);
      graph.push(`[${trackIn[k]}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${d}|${d},volume=${num(t.volume)}[x${k}]`);
    });
    graph.push(`[ac]${spec.audioTracks.map((_, k) => `[x${k}]`).join("")}amix=inputs=${spec.audioTracks.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);
  } else graph.push(`[ac]anull[aout]`);

  args.push(
    "-filter_complex", graph.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-t", num(total),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    i.output,
  );
  return { args, files, width: W, height: H, duration: total };
}

/** Parse FFmpeg `-progress` output ("out_time_us=…") into seconds rendered so far. */
export function parseProgress(chunk: string): number | null {
  const m = [...chunk.matchAll(/out_time_us=(\d+)/g)].pop();
  return m ? Number(m[1]) / 1e6 : null;
}
