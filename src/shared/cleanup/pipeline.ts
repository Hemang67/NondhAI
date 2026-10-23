import { applyRules, type DictionaryEntry } from "./rules";
import { acceptCleanupOutput, buildCleanupMessages, type ChatMessage } from "./llmCleanup";

/**
 * Things the deterministic rules deliberately leave alone. When none are present the rule
 * output is already as good as the LLM's, so "auto" mode skips the LLM and its latency.
 */
const LLM_CUES: RegExp[] = [
  /\blike\b/i, // filler "like" that wasn't fenced by commas
  /\byou know\b/i,
  /\bI mean\b/i,
  /\b(?:no wait|wait no|actually no|sorry|scratch that|rather)\b/i, // corrections rules didn't resolve
  /\b(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|bullet|number one|item one|next item)\b/i, // dictated lists
  /\b(\w+) \1\b/i, // stutter repeats ("the the")
  /\b(?:kind of|sort of|basically|literally)\b/i,
];

export function needsLlm(ruleText: string): boolean {
  return LLM_CUES.some((re) => re.test(ruleText));
}

export interface CleanupRequest {
  raw: string;
  dictionary: DictionaryEntry[];
  mode: "auto" | "always" | "never";
  translateTo?: string;
}

export type LlmCall = (messages: ChatMessage[]) => Promise<string>;

export interface CleanupOutcome {
  text: string;
  usedLlm: boolean;
  llmRejected: boolean;
  llmError?: string;
}

export async function runCleanup(req: CleanupRequest, llm: LlmCall | null): Promise<CleanupOutcome> {
  const ruled = applyRules(req.raw, { dictionary: req.dictionary });
  const translating = !!req.translateTo;
  if (!ruled) return { text: "", usedLlm: false, llmRejected: false };
  const want = translating || req.mode === "always" || (req.mode === "auto" && needsLlm(ruled));
  if (!want || !llm || (req.mode === "never" && !translating)) {
    return { text: ruled, usedLlm: false, llmRejected: false };
  }
  const terms = req.dictionary.map((d) => (d.kind === "replace" ? (d.replacement ?? d.term) : d.term));
  const messages = buildCleanupMessages(ruled, { terms, translateTo: req.translateTo });
  try {
    const out = await llm(messages);
    const accepted = acceptCleanupOutput(ruled, out, { translated: translating });
    if (accepted === null) return { text: ruled, usedLlm: true, llmRejected: true };
    // The LLM may undo dictionary spellings; re-apply them (not for translations).
    const final = translating ? accepted : applyRules(accepted, { dictionary: req.dictionary });
    return { text: final || ruled, usedLlm: true, llmRejected: false };
  } catch (err) {
    return { text: ruled, usedLlm: true, llmRejected: false, llmError: err instanceof Error ? err.message : String(err) };
  }
}
