import type { MeetingSummary, SpeakerLabel, TranscriptLine } from "./types";

export interface ExportInput {
  title: string;
  startedAt: number;
  durationMs: number;
  lines: TranscriptLine[];
  speakers: Record<string, Pick<SpeakerLabel, "name">>;
  summary?: MeetingSummary | null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function stamp(ms: number, sep: "," | "."): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

const nameOf = (i: ExportInput, l: TranscriptLine) => i.speakers[l.speakerKey]?.name ?? "Unknown";

/** Consecutive lines from the same speaker read better as one paragraph. */
function paragraphs(i: ExportInput): Array<{ start: number; end: number; name: string; text: string; flags: string }> {
  const out: Array<{ start: number; end: number; name: string; text: string; flags: string }> = [];
  for (const l of i.lines) {
    const name = nameOf(i, l);
    const flags = [l.overlap ? "overlapping speech" : "", l.uncertainSpeaker ? "speaker uncertain" : ""].filter(Boolean).join(", ");
    const last = out[out.length - 1];
    if (last && last.name === name && !flags && !last.flags && l.start - last.end < 4000) {
      last.text += " " + l.text;
      last.end = l.end;
    } else out.push({ start: l.start, end: l.end, name, text: l.text, flags });
  }
  return out;
}

export function summaryMarkdown(s: MeetingSummary): string {
  const list = (items: string[]) => (items.length ? items.map((x) => `- ${x}`).join("\n") : "- None");
  const notes = s.topics?.length
    ? s.topics.flatMap((t) => [`## ${t.heading}`, "", ...t.sections.flatMap((sec) => [`### ${sec.heading}`, list(sec.points), ""])])
    : ["## Key points", list(s.keyPoints), "", "## Decisions", list(s.decisions), ""];
  return [
    ...notes,
    "## Action items",
    s.actionItems.length
      ? s.actionItems.map((a) => `- [ ] ${a.task}${a.owner ? ` — **${a.owner}**` : ""}${a.due ? ` (due ${a.due})` : ""}`).join("\n")
      : "- None",
    "",
    "## Open questions",
    list(s.openQuestions),
  ].join("\n");
}

export function toMarkdown(i: ExportInput): string {
  const head = [`# ${i.title}`, "", `${new Date(i.startedAt).toLocaleString()} · ${clock(i.durationMs)}`, ""];
  const sum = i.summary ? [summaryMarkdown(i.summary), "", "## Transcript", ""] : ["## Transcript", ""];
  const body = paragraphs(i).map((p) => `**${p.name}** [${clock(p.start)}]${p.flags ? ` _(${p.flags})_` : ""}: ${p.text}`);
  return [...head, ...sum, ...body.flatMap((b) => [b, ""])].join("\n").trimEnd() + "\n";
}

export function toText(i: ExportInput): string {
  const body = paragraphs(i).map((p) => `[${clock(p.start)}] ${p.name}${p.flags ? ` (${p.flags})` : ""}: ${p.text}`);
  return [i.title, new Date(i.startedAt).toLocaleString(), "", ...body].join("\n") + "\n";
}

/** Subtitles keep one cue per line, capped at ~7 s so long monologues stay readable. */
function cues(i: ExportInput): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  for (const l of i.lines) {
    const name = nameOf(i, l);
    const words = l.text.split(/\s+/);
    const dur = Math.max(1, l.end - l.start);
    const chunks = Math.max(1, Math.ceil(dur / 7000));
    const per = Math.ceil(words.length / chunks);
    for (let c = 0; c < chunks; c++) {
      const part = words.slice(c * per, (c + 1) * per).join(" ");
      if (!part) continue;
      out.push({ start: l.start + Math.round((dur * c) / chunks), end: l.start + Math.round((dur * (c + 1)) / chunks), text: `${name}: ${part}` });
    }
  }
  return out;
}

export function toSrt(i: ExportInput): string {
  return cues(i)
    .map((c, n) => `${n + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`)
    .join("\n");
}

export function toVtt(i: ExportInput): string {
  return "WEBVTT\n\n" + cues(i).map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.text}\n`).join("\n");
}

export function transcriptForLlm(i: Pick<ExportInput, "lines" | "speakers">): string {
  return paragraphs({ ...i, title: "", startedAt: 0, durationMs: 0 })
    .map((p) => `[${clock(p.start)}] ${p.name}: ${p.text}`)
    .join("\n");
}
