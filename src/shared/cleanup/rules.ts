/**
 * Deterministic cleanup pass. Runs before the LLM (so the LLM sees less noise) and is
 * the whole cleanup when no LLM is available. It is deliberately conservative: anything
 * ambiguous ("like", "I mean", list formatting) is left to the LLM.
 */
export interface DictionaryEntry {
  term: string;
  kind: "name" | "jargon" | "replace";
  /** For kind "replace": the spoken form to look for (defaults to term). */
  match?: string;
  replacement?: string;
}

export interface RuleOptions {
  dictionary: DictionaryEntry[];
}

const FILLERS = ["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "hmm", "mm"];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function removeFillers(text: string): string {
  const alt = FILLERS.join("|");
  // A filler with its surrounding commas: "so, uh, we" → "so we"; "Um, so" → "so".
  // A sentence-ending mark after it is kept unless the filler was the whole sentence.
  const re = new RegExp(`(,\\s*)?(?<![\\w'])(?:${alt})(?![\\w'])([,.!?])?`, "gi");
  let out = text.replace(re, (_m, _comma, mark: string | undefined, offset: number, whole: string) => {
    const before = whole.slice(0, offset).trimEnd();
    const sentenceStart = before === "" || /[.!?]$/.test(before);
    return mark && mark !== "," && !sentenceStart ? mark : " ";
  });
  // "like" only when fenced by commas: "it was, like, big".
  out = out.replace(/,\s*like,\s*/gi, " ");
  return out;
}

type TokenClass = "weekday" | "month" | "number" | "name" | null;

function classify(word: string): TokenClass {
  const w = word.toLowerCase().replace(/[^a-z0-9:]/g, "");
  if (WEEKDAYS.includes(w)) return "weekday";
  if (MONTHS.includes(w)) return "month";
  if (/^\d+(?::\d+)?$/.test(w)) return "number";
  // A capitalized word that isn't "I" — in mid-sentence that is almost always a name.
  if (/^[A-Z][a-z]+$/.test(word.replace(/[^A-Za-z]/g, "")) && w !== "i") return "name";
  return null;
}

/**
 * "Tuesday — no, Wednesday" / "at 3, no wait, 4 pm" → keep only the correction, but only
 * when the corrected and correcting words are the same kind of thing (day, month, number).
 * That avoids eating a real "no" ("I said no, thanks").
 */
function applySelfCorrections(text: string): string {
  const marker =
    /(\S+)\s*(?:—|–|-{1,2}|,)\s*(?:no wait|no, wait|no|sorry|actually|I mean)\s*[,—–-]?\s*([^\s,]+)(,?)/g;
  return text.replace(marker, (whole, before: string, after: string, comma: string, offset: number, all: string) => {
    const a = classify(before);
    if (!a || a !== classify(after)) return whole;
    // A name at the very start of a sentence may just be a capitalized word.
    if (a === "name" && (offset === 0 || /[.!?]\s*$/.test(all.slice(0, offset)))) return whole;
    const lead = before.match(/^\W*/)?.[0] ?? "";
    // "John, I mean Sarah, by tomorrow" → "Sarah by tomorrow": the closing comma belonged to the aside.
    return lead + after;
  });
}

function applyScratchThat(text: string): string {
  // Drop "scratch that" and the sentence right before it.
  return text.replace(/(?:^|(?<=[.!?]\s))[^.!?]*[.!?]?\s*(?:scratch that|delete that)[.!,]?\s*/gi, "");
}

function applySpokenBreaks(text: string): string {
  return text
    .replace(/[,.]?\s*\bnew paragraph\b[,.]?\s*/gi, "\n\n")
    .replace(/[,.]?\s*\bnew line\b[,.]?\s*/gi, "\n");
}

function applyDictionary(text: string, dict: DictionaryEntry[]): string {
  let out = text;
  for (const e of dict) {
    const target = e.kind === "replace" ? (e.replacement ?? e.term) : e.term;
    const spoken = e.kind === "replace" ? (e.match ?? e.term) : e.term;
    if (!spoken.trim()) continue;
    const re = new RegExp(`(?<![\\w])${escapeRe(spoken).replace(/\s+/g, "\\s+")}(?![\\w])`, "gi");
    out = out.replace(re, target);
  }
  return out;
}

function fixCase(text: string): string {
  let out = text.replace(/\bi\b(?=[\s',.!?]|$)/g, "I");
  // Capitalize at the start, after sentence ends, and after line breaks.
  out = out.replace(/(^\s*|[.!?]\s+|\n\s*)([a-z])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
  return out;
}

function tidySpacing(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]+/g, " ")
        .replace(/\s+([,.!?;:])/g, "$1")
        .replace(/([,;:])(?=[.!?])/g, "")
        .replace(/^[\s,.;:]+/, "")
        .replace(/,(\s*,)+/g, ",")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function applyRules(input: string, opts: RuleOptions): string {
  let t = input;
  t = removeFillers(t);
  t = applyScratchThat(t);
  t = applySelfCorrections(t);
  t = applySpokenBreaks(t);
  t = applyDictionary(t, opts.dictionary);
  t = tidySpacing(t);
  // Sentences that were nothing but fillers leave stray punctuation behind.
  if (/^[\s.,!?]*$/.test(t)) return "";
  return fixCase(t);
}
