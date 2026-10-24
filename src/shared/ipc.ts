import type { ClipKind, ClipRecord, DictationRecord, DictionaryRow, MeetingRecord, ModelInfo, PersonRecord, PillState, SetupStatus } from "./types";
import type { Rect } from "./screen";
import type { CalendarRange } from "./calendar";
import type { Settings } from "./settings";
import type { SpeakerLabel, TranscriptLine } from "./meeting/types";
import type { FolderRecord, NoteRecord, SearchHit } from "./notes";
import type { BlurBox, LibraryVideo, ProjectSpec, SubtitleLine, VideoProject } from "./video/project";

export interface ScreenSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string;
  displayId: string | null;
}

export interface ScreenState {
  clipId: string;
  meetingId: string;
  kind: ClipKind;
  label: string;
  startedAt: number;
}

export interface RecordingState {
  id: string;
  title: string;
  kind: "call" | "room" | "import";
  startedAt: number;
  mic: string;
  system: string;
}

export interface MeetingDetail {
  meeting: MeetingRecord;
  lines: TranscriptLine[];
  speakers: Array<SpeakerLabel & { confirmed: boolean }>;
  /** Attendee names from the linked calendar event, offered when naming speakers. */
  suggestions: string[];
  /** Screen recordings made during the meeting, in time order. */
  clips: ClipRecord[];
}

/** A meeting with finished screen recordings, as listed in the video library. */
export interface LibraryMeeting {
  id: string;
  title: string;
  startedAt: number;
  clips: ClipRecord[];
}

export interface VideoProjectDetail {
  project: VideoProject;
  /** A meeting's screen recordings, or videos imported into the library. */
  source: "meeting" | "library";
  /** The owner: a meeting, or (id "library") the imported videos. hasAudio: there is sound to use. */
  meeting: { id: string; title: string; hasAudio: boolean };
  clips: ClipRecord[];
  lines: TranscriptLine[];
  speakers: Record<string, string>;
}

export interface VideoProgress {
  phase: "preparing" | "rendering" | "scanning" | "importing" | "transcribing" | "done" | "error" | "cancelled";
  fraction: number;
  error?: string;
}

export type ExportFormat = "md" | "txt" | "docx" | "srt" | "vtt";
export type NoteAction = "summarize" | "rewrite" | "tasks" | "email";

export interface AssistantState {
  phase: "listening" | "thinking" | "answer" | "error";
  command?: string;
  answer?: string;
  error?: string;
  cloud?: boolean;
}

/** renderer → main request/response */
export interface InvokeMap {
  "settings:get": [[], Settings];
  "settings:update": [[patch: unknown], Settings];
  "secrets:status": [[], Record<string, boolean>];
  "secrets:set": [[name: string, value: string], void];
  "history:list": [[opts: { query?: string; limit?: number }], DictationRecord[]];
  "history:delete": [[id: string], void];
  "history:copy": [[id: string, which: "clean" | "raw"], void];
  "history:toNote": [[id: string], NoteRecord];
  "dictionary:list": [[], DictionaryRow[]];
  "dictionary:upsert": [[row: Omit<DictionaryRow, "id"> & { id?: string }], DictionaryRow];
  "dictionary:delete": [[id: string], void];
  "models:list": [[], ModelInfo[]];
  "models:download": [[id: string], void];
  "models:cancel": [[id: string], void];
  "models:delete": [[id: string], void];
  "models:setup": [[], SetupStatus];
  "models:setupRetry": [[], void];
  "app:info": [[], { version: string; modelsDir: string; userData: string; meetingsDir: string; apiToken: string | null; mcpCommand: string }];
  "app:pickFolder": [[], string | null];
  "app:deleteAllAudio": [[], void];
  "app:deleteEverything": [[], void];
  "app:setDatabaseEncryption": [[enabled: boolean], void];
  "dictation:toggle": [[], void];
  // meetings
  "meetings:list": [[opts: { query?: string }], MeetingRecord[]];
  "meetings:get": [[id: string], MeetingDetail | null];
  "meetings:start": [[opts: { kind: "call" | "room"; title?: string }], RecordingState];
  "meetings:stop": [[], string | null];
  "meetings:recording": [[], RecordingState | null];
  "meetings:rename": [[id: string, title: string], void];
  "meetings:renameSpeaker": [[id: string, key: string, name: string], void];
  "meetings:setLineSpeaker": [[id: string, lineId: string, key: string], void];
  "meetings:editLine": [[id: string, lineId: string, text: string], void];
  "meetings:summarize": [[id: string], void];
  "meetings:ask": [[id: string | null, question: string], { answer: string; cloud: boolean }];
  "meetings:export": [[id: string, format: ExportFormat], string | null];
  "meetings:deleteAudio": [[id: string], void];
  "meetings:delete": [[id: string], void];
  "meetings:reprocess": [[id: string], void];
  "meetings:import": [[paths?: string[]], string[]];
  "meetings:toNote": [[id: string], NoteRecord];
  "meetings:copyConsent": [[], void];
  // people
  "people:list": [[], PersonRecord[]];
  "people:rename": [[id: string, name: string], void];
  "people:delete": [[id: string], void];
  "people:enroll": [[name: string, samples: Float32Array], void];
  "toast:respond": [[action: "record" | "dismiss" | "stop"], void];
  // notes & search
  "notes:list": [[opts: { folderId?: string | null; query?: string }], NoteRecord[]];
  "notes:get": [[id: string], NoteRecord | null];
  "notes:create": [[n: { title?: string; folderId?: string | null; bodyJson?: string; bodyText?: string }], NoteRecord];
  "notes:update": [[id: string, patch: { title?: string; folderId?: string | null; bodyJson?: string; bodyText?: string }], NoteRecord];
  "notes:delete": [[id: string], void];
  "notes:action": [[id: string, action: NoteAction], { text: string; cloud: boolean }];
  "folders:list": [[], FolderRecord[]];
  "folders:create": [[name: string, parentId?: string | null], FolderRecord];
  "folders:rename": [[id: string, name: string], void];
  "folders:delete": [[id: string], void];
  "search:query": [[q: string, opts?: { semantic?: boolean }], SearchHit[]];
  // assistant
  "assistant:paste": [[], void];
  "assistant:close": [[], void];
  // calendar
  "calendar:status": [[], { google: boolean; microsoft: boolean; googleBuiltIn: boolean; googleAccount: string | null }];
  /** Calendar page: events in [from, to) plus recordings in that range that no event links to. */
  "calendar:events": [[from: number, to: number], CalendarRange];
  "calendar:connect": [[provider: "google" | "microsoft"], void];
  "calendar:disconnect": [[provider: "google" | "microsoft"], void];
  "calendar:upcoming": [[], Array<{ id: string; title: string; start: number; end: number; attendees: string[]; provider: string }>];
  "updates:status": [[], { state: string; version?: string; error?: string }];
  "updates:check": [[], void];
  "updates:install": [[], void];
  // screen recording during a meeting
  "screen:sources": [[], ScreenSource[]];
  "screen:pickRegion": [[displayId: string | null], { rect: Rect; displayId: string } | null];
  "screen:start": [[opts: { sourceId: string; kind: ClipKind; label: string; region?: Rect; displayId?: string | null }], ClipRecord];
  "screen:stop": [[], void];
  "screen:state": [[], ScreenState | null];
  "clips:delete": [[id: string], void];
  "region:done": [[rect: Rect | null], void];
  // video library & editor
  "video:library": [[], { meetings: LibraryMeeting[]; imported: LibraryVideo[]; projects: VideoProject[] }];
  "video:create": [[meetingId: string | null, clipIds: string[], title?: string], VideoProject];
  "video:import": [[paths?: string[]], LibraryVideo[]];
  "video:deleteImported": [[id: string], void];
  "video:renameImported": [[id: string, title: string], void];
  "video:speechSubtitles": [[id: string, spec: ProjectSpec], SubtitleLine[]];
  "video:get": [[id: string], VideoProjectDetail | null];
  "video:save": [[id: string, patch: { title?: string; spec?: ProjectSpec }], VideoProject | null];
  "video:subtitles": [[id: string, spec: ProjectSpec], SubtitleLine[]];
  "video:delete": [[id: string], void];
  "video:export": [[id: string], void];
  "video:cancel": [[id: string], void];
  "video:saveCopy": [[id: string], string | null];
  "video:findSensitive": [[id: string, spec: ProjectSpec], BlurBox[]];
  "video:pickAsset": [[id: string, kind: "image" | "audio"], { file: string; name: string } | null];
}

/** main → renderer events */
export interface EventMap {
  "pill:state": [PillState];
  "recorder:start": [sessionId: string];
  "recorder:stop": [sessionId: string];
  "models:changed": [];
  "history:changed": [];
  "meeting:state": [RecordingState | null];
  "meeting:line": [meetingId: string, line: TranscriptLine];
  "meeting:level": [mic: number, system: number];
  "meeting:progress": [meetingId: string, text: string];
  "meetings:changed": [];
  "people:changed": [];
  "notes:changed": [];
  "toast:show": [info: { kind: "detected" | "ended"; app: string }];
  "assistant:state": [AssistantState];
  "updates:status": [{ state: string; version?: string; error?: string }];
  "screen:state": [ScreenState | null];
  "screen:begin": [job: { clipId: string; sourceId: string; region: Rect | null; display: { width: number; height: number } | null }];
  "screen:end": [clipId: string];
  "video:progress": [id: string, p: VideoProgress];
  "video:changed": [];
}

/** renderer → main fire-and-forget */
export interface SendMap {
  "recorder:chunk": [sessionId: string, samples: Float32Array];
  "recorder:started": [sessionId: string, error: string | null];
  "recorder:stopped": [sessionId: string];
  "screen:chunk": [clipId: string, data: ArrayBuffer];
  "screen:started": [clipId: string, error: string | null, width: number, height: number];
  "screen:ended": [clipId: string, width: number, height: number];
}

type Keys<T> = ReadonlyArray<keyof T>;
export const INVOKE_CHANNELS = [
  "settings:get", "settings:update", "secrets:status", "secrets:set",
  "history:list", "history:delete", "history:copy", "history:toNote",
  "dictionary:list", "dictionary:upsert", "dictionary:delete",
  "models:list", "models:download", "models:cancel", "models:delete", "models:setup", "models:setupRetry",
  "app:info", "app:pickFolder", "app:deleteAllAudio", "app:deleteEverything", "app:setDatabaseEncryption",
  "dictation:toggle",
  "meetings:list", "meetings:get", "meetings:start", "meetings:stop", "meetings:recording", "meetings:rename",
  "meetings:renameSpeaker", "meetings:setLineSpeaker", "meetings:editLine", "meetings:summarize", "meetings:ask",
  "meetings:export", "meetings:deleteAudio", "meetings:delete", "meetings:reprocess", "meetings:import",
  "meetings:toNote", "meetings:copyConsent",
  "people:list", "people:rename", "people:delete", "people:enroll", "toast:respond",
  "notes:list", "notes:get", "notes:create", "notes:update", "notes:delete", "notes:action",
  "folders:list", "folders:create", "folders:rename", "folders:delete", "search:query",
  "assistant:paste", "assistant:close",
  "calendar:status", "calendar:connect", "calendar:disconnect", "calendar:upcoming", "calendar:events",
  "updates:status", "updates:check", "updates:install",
  "screen:sources", "screen:pickRegion", "screen:start", "screen:stop", "screen:state", "clips:delete", "region:done",
  "video:library", "video:create", "video:get", "video:save", "video:subtitles", "video:delete", "video:export", "video:cancel",
  "video:saveCopy", "video:findSensitive", "video:pickAsset", "video:import", "video:deleteImported", "video:renameImported",
  "video:speechSubtitles",
] as const satisfies Keys<InvokeMap>;
export const EVENT_CHANNELS = [
  "pill:state", "recorder:start", "recorder:stop", "models:changed", "history:changed",
  "meeting:state", "meeting:line", "meeting:level", "meeting:progress", "meetings:changed", "people:changed",
  "notes:changed", "toast:show", "assistant:state", "updates:status", "screen:state", "screen:begin", "screen:end",
  "video:progress", "video:changed",
] as const satisfies Keys<EventMap>;
export const SEND_CHANNELS = [
  "recorder:chunk", "recorder:started", "recorder:stopped", "screen:chunk", "screen:started", "screen:ended",
] as const satisfies Keys<SendMap>;

export interface VdApi {
  invoke<K extends keyof InvokeMap>(channel: K, ...args: InvokeMap[K][0]): Promise<InvokeMap[K][1]>;
  send<K extends keyof SendMap>(channel: K, ...args: SendMap[K]): void;
  on<K extends keyof EventMap>(channel: K, cb: (...args: EventMap[K]) => void): () => void;
  /** Absolute path of a file dropped onto the window (Electron webUtils). */
  pathForFile(file: File): string;
  /** Base URL of the app's local media server (meeting audio, clips, edits). */
  mediaBase(): string;
}
