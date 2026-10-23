import type { ChatMessage } from "../cleanup/llmCleanup";
import type { MeetingSummary } from "./types";

export function buildSummaryMessages(transcript: string, ctx: { title: string; attendees?: string[] }): ChatMessage[] {
  const system = [
    "You write meeting notes from a transcript. Be specific and faithful: only include what was actually said.",
    "Reply with JSON only, matching this shape:",
    '{"keyPoints": string[], "decisions": string[], "actionItems": [{"task": string, "owner": string|null, "due": string|null}], "openQuestions": string[]}',
    "Owners must be names (or \"Me\") that appear in the transcript; use null when nobody took the task.",
    "Use empty arrays when there is nothing for a section. Keep each item to one sentence.",
  ].join("\n");
  const head = `Meeting: ${ctx.title}${ctx.attendees?.length ? `\nAttendees: ${ctx.attendees.join(", ")}` : ""}`;
  return [
    { role: "system", content: system },
    { role: "user", content: `${head}\n\n<transcript>\n${transcript}\n</transcript>` },
  ];
}

const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()) : [];

/** Parse the model's JSON, tolerating code fences, prose around it, and missing fields. */
export function parseSummary(raw: string): MeetingSummary | null {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  const items = Array.isArray(j.actionItems) ? j.actionItems : [];
  return {
    keyPoints: strings(j.keyPoints),
    decisions: strings(j.decisions),
    actionItems: items
      .map((a: unknown) => {
        if (typeof a === "string") return { task: a, owner: null, due: null };
        const o = a as Record<string, unknown>;
        return {
          task: typeof o?.task === "string" ? o.task.trim() : "",
          owner: typeof o?.owner === "string" && o.owner.trim() ? o.owner.trim() : null,
          due: typeof o?.due === "string" && o.due.trim() ? o.due.trim() : null,
        };
      })
      .filter((a) => a.task),
    openQuestions: strings(j.openQuestions),
  };
}

/** Long meetings exceed small local context windows: split by lines into ~maxChars chunks. */
export function chunkTranscript(transcript: string, maxChars: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of transcript.split("\n")) {
    if (cur && cur.length + line.length + 1 > maxChars) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) out.push(cur);
  return out;
}

export function mergeSummaries(parts: MeetingSummary[]): MeetingSummary {
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    keyPoints: uniq(parts.flatMap((p) => p.keyPoints)),
    decisions: uniq(parts.flatMap((p) => p.decisions)),
    actionItems: parts.flatMap((p) => p.actionItems),
    openQuestions: uniq(parts.flatMap((p) => p.openQuestions)),
  };
}

export function buildQaMessages(question: string, context: string, scope: "meeting" | "all"): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Answer the question using only the meeting material provided. Quote names and times when useful. " +
        "If the material doesn't answer it, say so plainly." +
        (scope === "all" ? " The material is excerpts from several meetings, each headed with its title and date." : ""),
    },
    { role: "user", content: `<material>\n${context}\n</material>\n\nQuestion: ${question}` },
  ];
}
