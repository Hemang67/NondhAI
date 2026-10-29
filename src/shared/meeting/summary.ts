import type { ChatMessage } from "../cleanup/llmCleanup";
import type { MeetingSummary, SummaryTopic } from "./types";

export function buildSummaryMessages(transcript: string, ctx: { title: string; attendees?: string[] }): ChatMessage[] {
  const system = [
    "You write detailed meeting notes from a transcript. Be specific and faithful: only include what was actually said.",
    "Reply with JSON only, matching this shape:",
    '{"title": string, "topics": [{"heading": string, "sections": [{"heading": string, "points": string[]}]}], "keyPoints": string[], "decisions": string[], "actionItems": [{"task": string, "owner": string|null, "due": string|null}], "openQuestions": string[]}',
    "title: a short name for the meeting from its content, 2-5 words (e.g. \"Testing Update Meeting\").",
    "topics: the detailed notes. One topic per subject discussed, in the order discussed, with a clear heading",
    "(e.g. \"Warehouse flow testing and integration\", \"Recent changes completed\", \"Open issues and observations\", \"Scheduling and coordination\").",
    "Split each topic into sections with short sub-headings (e.g. \"Current testing status\", \"Scope of validation\", \"Next steps\").",
    "Points are short, concrete phrases (not full paragraphs) and keep names, numbers, features and dates exactly as said.",
    "Cover everything of substance in the meeting; skip greetings and small talk.",
    "keyPoints: the 3-6 most important points overall. decisions: what was agreed.",
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
  const text = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  const topics = (Array.isArray(j.topics) ? j.topics : [])
    .map((t: Record<string, unknown>): SummaryTopic => ({
      heading: text(t?.heading),
      sections: (Array.isArray(t?.sections) ? t.sections : [])
        .map((s: Record<string, unknown>) => ({ heading: text(s?.heading), points: strings(s?.points) }))
        .filter((s: { points: string[] }) => s.points.length),
    }))
    .filter((t: SummaryTopic) => t.heading && t.sections.length);
  return {
    ...(text(j.title) ? { title: text(j.title) } : {}),
    ...(topics.length ? { topics } : {}),
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
  // A topic can span two chunks of a long meeting: join same-named topics and sections.
  const topics: SummaryTopic[] = [];
  for (const t of parts.flatMap((p) => p.topics ?? [])) {
    const same = topics.find((x) => x.heading.toLowerCase() === t.heading.toLowerCase());
    if (!same) {
      topics.push({ heading: t.heading, sections: t.sections.map((s) => ({ ...s, points: [...s.points] })) });
      continue;
    }
    for (const s of t.sections) {
      const sec = same.sections.find((x) => x.heading.toLowerCase() === s.heading.toLowerCase());
      if (sec) sec.points = uniq([...sec.points, ...s.points]);
      else same.sections.push({ ...s, points: [...s.points] });
    }
  }
  const title = parts.find((p) => p.title)?.title;
  return {
    ...(title ? { title } : {}),
    ...(topics.length ? { topics } : {}),
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
