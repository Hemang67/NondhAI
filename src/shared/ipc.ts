import type { DictationRecord, DictionaryRow, ModelInfo, PillState } from "./types";
import type { Settings } from "./settings";

/** renderer → main request/response */
export interface InvokeMap {
  "settings:get": [[], Settings];
  "settings:update": [[patch: unknown], Settings];
  "secrets:status": [[], Record<string, boolean>];
  "secrets:set": [[name: string, value: string], void];
  "history:list": [[opts: { query?: string; limit?: number }], DictationRecord[]];
  "history:delete": [[id: string], void];
  "history:copy": [[id: string, which: "clean" | "raw"], void];
  "dictionary:list": [[], DictionaryRow[]];
  "dictionary:upsert": [[row: Omit<DictionaryRow, "id"> & { id?: string }], DictionaryRow];
  "dictionary:delete": [[id: string], void];
  "models:list": [[], ModelInfo[]];
  "models:download": [[id: string], void];
  "models:cancel": [[id: string], void];
  "models:delete": [[id: string], void];
  "app:info": [[], { version: string; modelsDir: string; userData: string }];
  "app:pickModelsDir": [[], string | null];
  "dictation:toggle": [[], void];
}

/** main → renderer events */
export interface EventMap {
  "pill:state": [PillState];
  "recorder:start": [sessionId: string];
  "recorder:stop": [sessionId: string];
  "models:changed": [];
  "history:changed": [];
}

/** renderer → main fire-and-forget */
export interface SendMap {
  "recorder:chunk": [sessionId: string, samples: Float32Array];
  "recorder:started": [sessionId: string, error: string | null];
  "recorder:stopped": [sessionId: string];
}

export const INVOKE_CHANNELS = [
  "settings:get", "settings:update", "secrets:status", "secrets:set",
  "history:list", "history:delete", "history:copy",
  "dictionary:list", "dictionary:upsert", "dictionary:delete",
  "models:list", "models:download", "models:cancel", "models:delete",
  "app:info", "app:pickModelsDir", "dictation:toggle",
] as const satisfies ReadonlyArray<keyof InvokeMap>;
export const EVENT_CHANNELS = [
  "pill:state", "recorder:start", "recorder:stop", "models:changed", "history:changed",
] as const satisfies ReadonlyArray<keyof EventMap>;
export const SEND_CHANNELS = [
  "recorder:chunk", "recorder:started", "recorder:stopped",
] as const satisfies ReadonlyArray<keyof SendMap>;

export interface VdApi {
  invoke<K extends keyof InvokeMap>(channel: K, ...args: InvokeMap[K][0]): Promise<InvokeMap[K][1]>;
  send<K extends keyof SendMap>(channel: K, ...args: SendMap[K]): void;
  on<K extends keyof EventMap>(channel: K, cb: (...args: EventMap[K]) => void): () => void;
}
