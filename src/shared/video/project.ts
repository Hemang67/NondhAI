import type { TranscriptLine } from "../meeting/types";

/** Rectangles are normalized to the output frame (0..1), so they survive any export size. */
export interface NRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One kept piece of a source clip, in source-clip seconds. The timeline is these, in order. */
export interface Segment {
  id: string;
  clipId: string;
  in: number;
  out: number;
}

export interface TimedRange {
  start: number; // timeline seconds
  end: number;
}

export interface BlurBox extends TimedRange {
  id: string;
  rect: NRect;
  strength: number; // 1..40
  /** Suggested by sensitive-info detection (shown for review until accepted). */
  suggested?: { reason: string; text: string };
}

export interface TextElement extends TimedRange {
  id: string;
  text: string;
  x: number; // normalized position of the top-left corner
  y: number;
  size: number; // fraction of output height (e.g. 0.05)
  color: string; // #rrggbb
  background: boolean;
}

export interface ImageElement extends TimedRange {
  id: string;
  file: string; // absolute path on disk
  x: number;
  y: number;
  w: number; // normalized width; height follows the image's aspect ratio
}

export interface AudioTrack {
  id: string;
  file: string;
  start: number; // timeline seconds where the track begins
  volume: number; // 0..2
}

export interface SubtitleLine {
  id: string;
  start: number; // timeline seconds
  end: number;
  text: string;
  speaker?: string;
}

export interface ProjectSpec {
  version: 1;
  segments: Segment[];
  crop: NRect | null;
  blurs: BlurBox[];
  texts: TextElement[];
  images: ImageElement[];
  meetingAudio: { enabled: boolean; volume: number };
  audioTracks: AudioTrack[];
  subtitles: { lines: SubtitleLine[]; burnIn: boolean; exportSrt: boolean };
}

export interface ClipRef {
  id: string;
  startMs: number; // where the clip starts on the meeting timeline
  duration: number; // seconds
}

/** A meeting clip as the timeline sees it (times in ms from the meeting start). */
export const clipRef = (c: { id: string; startMs: number; endMs: number | null }): ClipRef => ({
  id: c.id,
  startMs: c.startMs,
  duration: Math.max(0, ((c.endMs ?? c.startMs) - c.startMs) / 1000),
});

let n = 0;
export const newId = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export function emptySpec(clips: ClipRef[]): ProjectSpec {
  return {
    version: 1,
    segments: clips.map((c) => ({ id: newId("s"), clipId: c.id, in: 0, out: c.duration })),
    crop: null,
    blurs: [],
    texts: [],
    images: [],
    meetingAudio: { enabled: true, volume: 1 },
    audioTracks: [],
    subtitles: { lines: [], burnIn: true, exportSrt: true },
  };
}

export const segLen = (s: Segment) => Math.max(0, s.out - s.in);

export function duration(spec: Pick<ProjectSpec, "segments">): number {
  return spec.segments.reduce((t, s) => t + segLen(s), 0);
}

/** Timeline time → which segment and the source time inside it. */
export function locate(spec: Pick<ProjectSpec, "segments">, t: number): { index: number; segment: Segment; sourceTime: number; segmentStart: number } | null {
  let acc = 0;
  for (let i = 0; i < spec.segments.length; i++) {
    const s = spec.segments[i]!;
    const len = segLen(s);
    if (t < acc + len || i === spec.segments.length - 1) {
      const within = Math.min(Math.max(0, t - acc), len);
      return { index: i, segment: s, sourceTime: s.in + within, segmentStart: acc };
    }
    acc += len;
  }
  return null;
}

/** Start time of each segment on the timeline. */
export function segmentStarts(spec: Pick<ProjectSpec, "segments">): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const s of spec.segments) {
    out.push(acc);
    acc += segLen(s);
  }
  return out;
}

/** Split the segment under the playhead into two. No-op at a segment boundary. */
export function splitAt(spec: ProjectSpec, t: number): ProjectSpec {
  const loc = locate(spec, t);
  if (!loc) return spec;
  const { segment: s, sourceTime, index } = loc;
  if (sourceTime - s.in < 0.05 || s.out - sourceTime < 0.05) return spec;
  const a = { ...s, out: sourceTime };
  const b = { ...s, id: newId("s"), in: sourceTime };
  const segments = [...spec.segments];
  segments.splice(index, 1, a, b);
  return { ...spec, segments };
}

/**
 * Remove a stretch of the timeline [from, to). Everything after it moves earlier, and timed
 * elements (blurs, texts, images, subtitles, audio) shift with it or are trimmed/dropped.
 */
export function cutRange(spec: ProjectSpec, from: number, to: number): ProjectSpec {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(duration(spec), Math.max(from, to));
  if (b - a < 0.01) return spec;
  let s = splitAt(splitAt(spec, a), b);
  const starts = segmentStarts(s);
  s = { ...s, segments: s.segments.filter((seg, i) => !(starts[i]! >= a - 1e-6 && starts[i]! + segLen(seg) <= b + 1e-6)) };
  const gap = b - a;
  const shift = <T extends TimedRange>(x: T): T | null => {
    if (x.end <= a) return x;
    if (x.start >= b) return { ...x, start: x.start - gap, end: x.end - gap };
    const start = x.start < a ? x.start : a;
    const end = x.end > b ? x.end - gap : a;
    return end - start > 0.05 ? { ...x, start, end } : null;
  };
  const keep = <T extends TimedRange>(xs: T[]) => xs.map(shift).filter((x): x is T => x !== null);
  return {
    ...s,
    blurs: keep(s.blurs),
    texts: keep(s.texts),
    images: keep(s.images),
    subtitles: { ...s.subtitles, lines: keep(s.subtitles.lines) },
    audioTracks: s.audioTracks.map((t) => (t.start >= b ? { ...t, start: t.start - gap } : t)),
  };
}

export function deleteSegment(spec: ProjectSpec, index: number): ProjectSpec {
  const starts = segmentStarts(spec);
  const seg = spec.segments[index];
  if (!seg || spec.segments.length === 1) return spec;
  return cutRange(spec, starts[index]!, starts[index]! + segLen(seg));
}

export function moveSegment(spec: ProjectSpec, index: number, dir: -1 | 1): ProjectSpec {
  const j = index + dir;
  if (j < 0 || j >= spec.segments.length) return spec;
  const segments = [...spec.segments];
  [segments[index], segments[j]] = [segments[j]!, segments[index]!];
  return { ...spec, segments };
}

/**
 * Where transcript lines appear on the edited timeline: each line inside a kept segment,
 * re-timed to the timeline. A line crossing a cut is clipped to the segment (and can appear
 * twice if the same stretch is kept twice).
 */
export function linesOnTimeline(
  spec: Pick<ProjectSpec, "segments">,
  clips: ClipRef[],
  lines: TranscriptLine[],
): Array<{ line: TranscriptLine; start: number; end: number }> {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const starts = segmentStarts(spec);
  const out: Array<{ line: TranscriptLine; start: number; end: number }> = [];
  spec.segments.forEach((seg, i) => {
    const clip = byId.get(seg.clipId);
    if (!clip) return;
    // Segment bounds on the meeting timeline (ms).
    const m0 = clip.startMs + seg.in * 1000;
    const m1 = clip.startMs + seg.out * 1000;
    for (const l of lines) {
      if (l.end <= m0 || l.start >= m1) continue;
      const s = Math.max(l.start, m0);
      const e = Math.min(l.end, m1);
      if (e - s < 300) continue;
      out.push({ line: l, start: starts[i]! + (s - m0) / 1000, end: starts[i]! + (e - m0) / 1000 });
    }
  });
  return out.sort((x, y) => x.start - y.start);
}

/** Subtitles for what the timeline actually shows, from the meeting transcript. */
export function subtitlesFromTranscript(
  spec: Pick<ProjectSpec, "segments">,
  clips: ClipRef[],
  lines: TranscriptLine[],
  speakerName: (key: string) => string,
): SubtitleLine[] {
  return linesOnTimeline(spec, clips, lines).map(({ line, start, end }) => ({
    id: newId("t"),
    start,
    end,
    text: line.text,
    speaker: speakerName(line.speakerKey),
  }));
}

const pad = (v: number, w = 2) => String(v).padStart(w, "0");
function srtTime(s: number): string {
  const ms = Math.round(s * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function toSrt(lines: SubtitleLine[], withSpeaker = true): string {
  return lines
    .filter((l) => l.text.trim())
    .map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${withSpeaker && l.speaker ? `${l.speaker}: ` : ""}${l.text.trim()}\n`)
    .join("\n");
}

/** Keep a normalized rectangle inside the frame with a minimum size. */
export function clampRect(r: NRect, min = 0.01): NRect {
  const w = Math.min(1, Math.max(min, r.w));
  const h = Math.min(1, Math.max(min, r.h));
  return { x: Math.min(1 - w, Math.max(0, r.x)), y: Math.min(1 - h, Math.max(0, r.y)), w, h };
}

/** A saved edit in the video library. */
export interface VideoProject {
  id: string;
  /** The meeting whose screen recordings it uses; null for an edit of imported videos. */
  meetingId: string | null;
  title: string;
  spec: ProjectSpec;
  exportFile: string | null;
  exportStatus: "none" | "rendering" | "done" | "error";
  exportError: string | null;
  exportedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** A video brought into the library from outside the app (kept as its own playable copy). */
export interface LibraryVideo {
  id: string;
  title: string;
  originalName: string;
  /** File name inside the library folder, once imported. */
  file: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasAudio: boolean;
  status: "importing" | "ready" | "error";
  error: string | null;
  createdAt: number;
}

/** Media-server path segment and owner id used for imported videos and their edits. */
export const LIBRARY = "library";

/**
 * Subtitle lines from recognized speech. Long utterances are split at word boundaries so each
 * line stays readable (about two short rows, a few seconds). `offset` moves the speech, which is
 * timed from the start of the audio it came from, onto the timeline; `limit` cuts it off there.
 */
export function speechToSubtitles(
  segments: Array<{ start: number; end: number; text: string; words: Array<{ w: string; start: number; end: number }> }>,
  offset: number,
  limit: number,
  maxChars = 84,
  maxSeconds = 6,
): SubtitleLine[] {
  const out: SubtitleLine[] = [];
  const push = (text: string, startMs: number, endMs: number) => {
    const start = offset + startMs / 1000;
    const end = Math.min(limit, offset + endMs / 1000);
    if (text.trim() && end - start > 0.1) out.push({ id: newId("t"), start, end, text: text.trim() });
  };
  for (const s of segments) {
    if (!s.words.length || (s.text.length <= maxChars && (s.end - s.start) / 1000 <= maxSeconds)) {
      push(s.text, s.start, s.end);
      continue;
    }
    let words: typeof s.words = [];
    const flush = () => {
      if (words.length) push(words.map((w) => w.w).join(" "), words[0]!.start, words.at(-1)!.end);
      words = [];
    };
    for (const w of s.words) {
      const text = [...words, w].map((x) => x.w).join(" ");
      if (words.length && (text.length > maxChars || (w.end - words[0]!.start) / 1000 > maxSeconds)) flush();
      words.push(w);
    }
    flush();
  }
  return out;
}
