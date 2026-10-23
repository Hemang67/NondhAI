import Anthropic from "@anthropic-ai/sdk";
import { join } from "node:path";
import type { ChatMessage } from "@shared/cleanup/llmCleanup";
import type { LlmProvider, LlmTarget, Settings } from "@shared/settings";
import { getSecret, type SecretName } from "../secrets";
import type { LlamaServer } from "./llamaServer";

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** "low" for quick edits (cleanup), higher for summaries. Cloud reasoning models only. */
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  cloud: boolean;
  provider: LlmProvider;
  model: string;
}

const OPENAI_COMPAT: Partial<Record<LlmProvider, string>> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

export const DEFAULT_CLOUD_MODELS: Partial<Record<LlmProvider, string>> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-5-mini",
  groq: "llama-3.3-70b-versatile",
  gemini: "gemini-2.5-flash",
  openrouter: "anthropic/claude-opus-5-5",
};

export class LlmClient {
  constructor(
    private readonly llama: LlamaServer,
    private readonly settings: () => Settings,
    private readonly modelsDir: () => string,
  ) {}

  isCloud(target: LlmTarget): boolean {
    return target.provider !== "local";
  }

  async chat(target: LlmTarget, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const s = this.settings();
    if (target.provider === "local") {
      const model = s.llm.localModel;
      const base = await this.llama.ensure(join(this.modelsDir(), "llm", model), s.llm.localGpu);
      const text = await openAiCompatChat(base, null, "local", messages, {
        ...opts,
        // Qwen-family templates think by default; cleanup must not.
        extra: { chat_template_kwargs: { enable_thinking: false } },
      });
      return { text, cloud: false, provider: "local", model };
    }
    const model = target.model || DEFAULT_CLOUD_MODELS[target.provider] || "";
    const key = getSecret(target.provider as SecretName);
    if (!key) throw new Error(`No API key saved for ${target.provider}`);
    if (target.provider === "anthropic") {
      return { text: await anthropicChat(key, model, messages, opts), cloud: true, provider: "anthropic", model };
    }
    const base = target.provider === "custom" ? s.llm.customBaseUrl : OPENAI_COMPAT[target.provider];
    if (!base) throw new Error(`No endpoint configured for ${target.provider}`);
    const text = await openAiCompatChat(base, key, model, messages, opts);
    return { text, cloud: true, provider: target.provider, model };
  }
}

async function openAiCompatChat(
  baseUrl: string,
  apiKey: string | null,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions & { extra?: Record<string, unknown> },
): Promise<string> {
  const r = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.2,
      stream: false,
      ...opts.extra,
    }),
    signal: opts.signal,
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return j.choices?.[0]?.message?.content ?? "";
}

async function anthropicChat(apiKey: string, model: string, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  const client = new Anthropic({ apiKey });
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest: Anthropic.Beta.BetaMessageParam[] = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const maxTokens = opts.maxTokens ?? 16000;
  // Server-side fallback: if the model declines a request on policy grounds, the API retries it
  // on the model's default fallback instead of returning an empty refusal.
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    system: system || undefined,
    messages: rest,
    output_config: { effort: opts.effort ?? "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
  const response =
    maxTokens > 16000
      ? await client.beta.messages.stream(params, { signal: opts.signal }).finalMessage()
      : await client.beta.messages.create(params, { signal: opts.signal });
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined the request (${response.stop_details?.category ?? "unspecified"})`);
  }
  return response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
