import type { SpeakerLabel, TranscriptLine } from "./types";

/** One spoken turn read from a transcript file; times are null when the file has none. */
export interface ImportedTurn {
  start: number | null;
  end: number | null;
  speaker: string | null;
  text: string;
}

const TIME = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?`;
// A speaker name: a few words, starting with a letter, no sentence punctuation.
const NAME = String.raw`[\p{L}][\p{L}\p{N} .'’_@-]{0,40}?`;

/** "1:02:03.5", "02:03", "0:05,250" → ms. */
export function parseTime(s: string): number {
  const [hms, frac = "0"] = s.trim().split(/[.,]/);
  const parts = hms!.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, sec] = parts as [number, number, number];
  return ((h * 60 + m) * 60 + sec) * 1000 + Math.round(Number(`0.${frac}`) * 1000);
}

const isName = (s: string) => s.split(/\s+/).length <= 5 && !/^(note|notes|summary|agenda|action items?|http|https)$/i.test(s.trim());
/** Stricter, for the shapes ordinary sentences can take ("So the plan: …", "Meet at 5:30"). */
const looksLikeName = (s: string) => isName(s) && (s.includes("@") || s.trim().split(/\s+/).every((w) => /^[\p{Lu}\p{N}]/u.test(w)));

/** WebVTT and SRT: timed cues; the speaker comes from a <v Name> tag or a "Name: " prefix. */
function parseCues(text: string): ImportedTurn[] {
  const out: ImportedTurn[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n\s*\n/);
  const range = new RegExp(String.raw`^\s*(${TIME})\s*-->\s*(${TIME})`);
  for (const b of blocks) {
    const rows = b.split("\n");
    const at = rows.findIndex((r) => range.test(r));
    if (at < 0) continue;
    const [, a, z] = rows[at]!.match(range)!;
    let body = rows.slice(at + 1).join(" ").trim();
    let speaker: string | null = null;
    const voice = body.match(/^<v(?:\.[^ >]+)?\s+([^>]+)>/);
    if (voice) speaker = voice[1]!.trim();
    body = body.replace(/<[^>]+>/g, "").trim();
    const named = body.match(new RegExp(String.raw`^(${NAME}):\s+(.+)$`, "u"));
    if (!speaker && named && isName(named[1]!)) {
      speaker = named[1]!.trim();
      body = named[2]!;
    }
    if (body) out.push({ start: parseTime(a!), end: parseTime(z!), speaker, text: body });
  }
  // Subtitles split one turn into short cues; join a speaker's back-to-back cues.
  const joined: ImportedTurn[] = [];
  for (const t of out) {
    const last = joined[joined.length - 1];
    if (last && t.speaker && last.speaker === t.speaker && t.start! - last.end! < 2000) {
      last.text += " " + t.text;
      last.end = t.end;
    } else joined.push({ ...t });
  }
  return joined;
}

/**
 * Plain text, Markdown or a Word document's paragraphs. Understands the common shapes:
 *   [0:12] Name: text            (Nondh AI .txt, many tools)
 *   **Name** [0:12]: text        (Nondh AI .md)
 *   Name (0:12): text / Name [0:12]: text / 0:12 Name: text
 *   Name  0:12  ⏎ text…          (Otter, Supernormal, Teams .docx)
 *   00:05:00 ⏎ Name: text…       (Google Meet: a time line, then named paragraphs)
 *   Name: text                   (no times)
 * Unrecognized lines continue the current speaker's turn.
 */
function parseText(text: string): ImportedTurn[] {
  const out: ImportedTurn[] = [];
  let clock: number | null = null;
  let speaker: string | null = null;
  let open: ImportedTurn | null = null; // a header was seen; its text follows on the next lines
  const push = (t: ImportedTurn) => {
    out.push(t);
    open = null;
  };
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => { time?: string; name: string; text: string; strict?: boolean }]> = [
    [new RegExp(String.raw`^\[(${TIME})\]\s*(${NAME})(?:\s*\([^)]*\))?:\s+(.+)$`, "u"), (m) => ({ time: m[1], name: m[2]!, text: m[3]! })],
    [new RegExp(String.raw`^\*\*(${NAME})\*\*\s*\[(${TIME})\](?:\s*_\([^)]*\)_)?:\s+(.+)$`, "u"), (m) => ({ time: m[2], name: m[1]!, text: m[3]! })],
    [new RegExp(String.raw`^(${NAME})\s*[([](${TIME})[)\]]:?\s+(.+)$`, "u"), (m) => ({ time: m[2], name: m[1]!, text: m[3]! })],
    [new RegExp(String.raw`^(${TIME})\s+(${NAME}):\s+(.+)$`, "u"), (m) => ({ time: m[1], name: m[2]!, text: m[3]! })],
    [new RegExp(String.raw`^\*{0,2}(${NAME})\*{0,2}:\s+(.+)$`, "u"), (m) => ({ name: m[1]!, text: m[2]!, strict: true })],
  ];
  const timeOnly = new RegExp(String.raw`^\[?(${TIME})\]?$`);
  const header = new RegExp(String.raw`^\[?(${NAME})\]?\s*[([]?(${TIME})[)\]]?$`, "u");

  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim().replace(/^[-*•]\s+/, "");
    if (!line || /^#+\s/.test(line) || /^-{3,}$/.test(line)) continue;
    let m = line.match(timeOnly);
    if (m) {
      clock = parseTime(m[1]!);
      continue;
    }
    m = line.match(header);
    if (m && looksLikeName(m[1]!)) {
      speaker = m[1]!.trim();
      clock = parseTime(m[2]!);
      open = { start: clock, end: null, speaker, text: "" };
      continue;
    }
    let hit: { time?: string; name: string; text: string } | null = null;
    for (const [re, pick] of patterns) {
      const mm = line.match(re);
      if (mm) {
        const h = pick(mm);
        if (h.strict ? looksLikeName(h.name) : isName(h.name)) {
          hit = h;
          break;
        }
      }
    }
    if (hit) {
      if (hit.time) clock = parseTime(hit.time);
      speaker = hit.name.trim();
      push({ start: hit.time ? clock : (clock ?? null), end: null, speaker, text: hit.text.trim() });
      clock = null; // a stand-alone time line applies to the next turn only
      continue;
    }
    // Text under a header, or more of the same turn.
    const cur: ImportedTurn | null = open;
    if (cur) {
      cur.text = line;
      push(cur);
      clock = null;
    } else if (out.length) out[out.length - 1]!.text += " " + line;
    else push({ start: clock, end: null, speaker, text: line });
  }
  // When the file names its speakers, unnamed text before the first one is a title, date or the
  // like, not speech.
  const first = out.findIndex((t) => t.speaker);
  return (first > 0 ? out.slice(first) : out).filter((t) => t.text.trim());
}

export function parseTranscript(text: string, fileName: string): ImportedTurn[] {
  const body = text.replace(/^﻿/, "");
  if (/\.(vtt|srt)$/i.test(fileName) || /^WEBVTT/.test(body) || /^\d+\s*\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(body.trim())) return parseCues(body);
  return parseText(body);
}

/** About 150 words a minute, for files without times. */
const MS_PER_WORD = 400;

/**
 * Turn parsed turns into transcript lines and speaker labels. Missing times are estimated from
 * the words spoken since the last known time; names matching a known person keep their id.
 */
export function buildImportedTranscript(
  turns: ImportedTurn[],
  findPerson: (name: string) => { id: string; isMe: boolean } | null,
): { lines: TranscriptLine[]; speakers: SpeakerLabel[]; durationMs: number } {
  const keys = new Map<string, string>();
  const speakers: SpeakerLabel[] = [];
  const keyFor = (name: string | null): string => {
    const n = (name ?? "").trim();
    if (!n) return "unknown";
    const lower = n.toLowerCase();
    if (!keys.has(lower)) {
      const person = findPerson(n);
      const key = person?.isMe ? "me" : `t${keys.size}`;
      keys.set(lower, key);
      if (!speakers.some((s) => s.key === key)) {
        speakers.push({ key, name: person?.isMe ? "Me" : n, personId: person?.id ?? null, score: null, confidence: "high" });
      }
    }
    return keys.get(lower)!;
  };

  let t = 0;
  const lines: TranscriptLine[] = turns.map((turn, i) => {
    const words = turn.text.split(/\s+/).filter(Boolean).length;
    const start = turn.start !== null ? Math.max(turn.start, 0) : t;
    const end = turn.end !== null && turn.end > start ? turn.end : start + Math.max(1000, words * MS_PER_WORD);
    t = Math.max(t, end);
    return {
      id: `imp${i}`,
      start,
      end,
      speakerKey: keyFor(turn.speaker),
      channel: "mixed",
      text: turn.text.trim(),
      conf: 1,
      overlap: false,
      uncertainSpeaker: false,
    };
  });
  lines.sort((a, b) => a.start - b.start);
  // An estimated end can run past the next line's start; trim it there.
  for (let i = 0; i + 1 < lines.length; i++) if (lines[i]!.end > lines[i + 1]!.start) lines[i]!.end = Math.max(lines[i]!.start, lines[i + 1]!.start);
  return { lines, speakers, durationMs: t };
}
