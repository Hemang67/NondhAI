export type SttEngine = "parakeet" | "whisper" | "cloud";
export type CloudSttProvider = "openai" | "groq" | "gemini" | "custom";
export type LlmProvider = "local" | "anthropic" | "openai" | "gemini" | "groq" | "openrouter" | "custom";

export interface LlmTarget {
  provider: LlmProvider;
  model: string;
}

export interface Settings {
  modelsDir: string; // empty = <userData>/models
  launchAtLogin: boolean;
  hotkeys: { dictate: string; translate: string; assistant: string; meeting: string };
  holdMs: number;
  doubleTapMs: number;
  stt: {
    engine: SttEngine;
    parakeetModel: string;
    whisperModel: string;
    whisperUseGpu: boolean;
    language: string; // "en" or "auto"
    cloud: { provider: CloudSttProvider; model: string; baseUrl: string };
  };
  cleanup: {
    enabled: boolean;
    /** auto = only when the text has things the rules can't handle (lists, "I mean", ...). */
    llmMode: "auto" | "always" | "never";
    llm: LlmTarget;
  };
  llm: {
    localModel: string; // gguf file name inside <modelsDir>/llm
    localGpu: boolean;
    customBaseUrl: string;
    assistant: LlmTarget;
    summaries: LlmTarget;
  };
  translate: { target: string };
  paste: { restoreClipboard: boolean; restoreDelayMs: number };
  ui: { showPill: boolean };
  meetings: {
    /** Folder for recordings; empty = <userData>/meetings. */
    dir: string;
    /** Detect Zoom/Teams/Meet/... calls and offer to record. */
    autoDetect: boolean;
    /** Echo cancellation on the mic track (for speakers; harmless on headphones). */
    aec: boolean;
    /** Delete recorded audio after this many days; 0 keeps it forever. Transcripts are kept. */
    keepAudioDays: number;
    encryptAudio: boolean;
    consentMessage: string;
    summarize: boolean;
  };
  privacy: { encryptDatabase: boolean };
  assistant: { includeScreenshot: boolean; answerMode: "panel" | "paste" };
  api: { enabled: boolean; port: number };
  calendar: { googleClientId: string; googleClientSecret: string; microsoftClientId: string };
  /** Update feed: a URL or a folder holding latest.yml + the installer. Empty = no automatic updates. */
  updates: { feedUrl: string };
}

export const DEFAULT_SETTINGS: Settings = {
  modelsDir: "",
  launchAtLogin: true,
  hotkeys: { dictate: "ctrl+win", translate: "ctrl+win+t", assistant: "ctrl+win+a", meeting: "ctrl+win+m" },
  holdMs: 300,
  doubleTapMs: 400,
  stt: {
    engine: "parakeet",
    parakeetModel: "parakeet-unified-en-0.6b",
    whisperModel: "small.en",
    whisperUseGpu: false,
    language: "en",
    cloud: { provider: "openai", model: "gpt-4o-mini-transcribe", baseUrl: "" },
  },
  cleanup: {
    enabled: true,
    llmMode: "auto",
    llm: { provider: "local", model: "" },
  },
  llm: {
    localModel: "Qwen_Qwen3.5-2B-Q4_K_M.gguf",
    localGpu: true,
    customBaseUrl: "",
    assistant: { provider: "anthropic", model: "claude-opus-5-5" },
    summaries: { provider: "anthropic", model: "claude-opus-5-5" },
  },
  translate: { target: "Spanish" },
  paste: { restoreClipboard: true, restoreDelayMs: 400 },
  ui: { showPill: true },
  meetings: {
    dir: "",
    autoDetect: true,
    aec: true,
    keepAudioDays: 0,
    encryptAudio: false,
    consentMessage: "Heads up: I'm recording this call for my notes. Let me know if you'd rather I didn't.",
    summarize: true,
  },
  privacy: { encryptDatabase: false },
  assistant: { includeScreenshot: false, answerMode: "panel" },
  api: { enabled: false, port: 47821 },
  calendar: { googleClientId: "", googleClientSecret: "", microsoftClientId: "" },
  updates: { feedUrl: "" },
};

/** Deep-merge saved settings over defaults so new fields get defaults after upgrades. */
export function mergeSettings(saved: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const merge = (b: unknown, s: unknown): unknown => {
    if (s === undefined) return b;
    if (b && typeof b === "object" && !Array.isArray(b) && s && typeof s === "object" && !Array.isArray(s)) {
      const out: Record<string, unknown> = { ...(b as Record<string, unknown>) };
      for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
        out[k] = k in out ? merge(out[k], v) : v;
      }
      return out;
    }
    return typeof s === typeof b ? s : b;
  };
  return merge(base, saved) as Settings;
}
