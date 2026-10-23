export type DictationMode = "dictate" | "translate" | "assistant";

export interface NewDictation {
  rawText: string;
  cleanText: string;
  mode: DictationMode;
  engine: string;
  model: string;
  durationMs: number;
  latencyMs: number;
  appName?: string | null;
  cloudUsed: boolean;
}

export interface DictationRecord extends Required<NewDictation> {
  id: string;
  createdAt: number;
  updatedAt: number;
  appName: string | null;
}

export interface DictionaryRow {
  id: string;
  term: string;
  match: string | null;
  replacement: string | null;
  kind: "name" | "jargon" | "replace";
}

export type PillState =
  | { kind: "hidden" }
  | { kind: "listening"; mode: DictationMode; locked: boolean }
  | { kind: "processing"; mode: DictationMode; cloud: boolean }
  | { kind: "error"; message: string };

export interface ModelInfo {
  id: string;
  engine: "parakeet" | "whisper" | "llm" | "speaker";
  name: string;
  sizeMb: number;
  description: string;
  installed: boolean;
  downloading?: { received: number; total: number };
}

export type MeetingKind = "call" | "room" | "import";
export type MeetingStatus = "recording" | "processing" | "ready" | "failed";

export interface MeetingRecord {
  id: string;
  title: string;
  kind: MeetingKind;
  status: MeetingStatus;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  dir: string;
  audioFile: string | null;
  audioEncrypted: boolean;
  audioExpiresAt: number | null;
  sourceApp: string | null;
  summary: import("./meeting/types").MeetingSummary | null;
  attendees: string[];
  calendarEventId: string | null;
  error: string | null;
  recovered: boolean;
}

export interface PersonRecord {
  id: string;
  name: string;
  isMe: boolean;
  voiceprints: number;
}

export interface SttResult {
  text: string;
  engine: string;
  model: string;
  cloud: boolean;
  ms: number;
}
