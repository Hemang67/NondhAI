import { app, clipboard, dialog, ipcMain, type BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { InvokeMap } from "@shared/ipc";
import { noteActionMessages } from "@shared/ai";
import { buildQaMessages } from "@shared/meeting/summary";
import { summaryMarkdown, toMarkdown, toSrt, toText, toVtt, transcriptForLlm } from "@shared/meeting/export";
import type { SettingsStore } from "./settingsStore";
import type { Store } from "./storage/store";
import type { MeetingRepo, PeopleRepo } from "./storage/meetings";
import type { NotesRepo } from "./storage/notes";
import type { SpeechService } from "./speech/speechService";
import type { LlmClient } from "./llm/llm";
import type { ModelManager } from "./models/modelManager";
import type { SearchService } from "./search/searchService";
import type { MeetingService, RecordingState } from "./meeting/meetingService";
import type { CalendarService } from "./calendar/calendarService";
import type { AssistantService } from "./assistant/assistantService";
import type { DictationController } from "./dictation/dictationController";
import { getSecret, hasSecret, INTERNAL_SECRETS, SECRET_NAMES, setSecret, type SecretName } from "./secrets";
import { SPEAKER_MODEL } from "./models/registry";
import { toDocx } from "./meeting/docx";
import { apiToken } from "./api/apiServer";
import { userDataPath } from "./paths";
import { log } from "./log";

export interface AppContext {
  settings: SettingsStore;
  store: Store;
  meetings: MeetingRepo;
  people: PeopleRepo;
  notes: NotesRepo;
  speech: SpeechService;
  llm: LlmClient;
  llmAvailable: (provider: string) => boolean;
  models: ModelManager;
  search: SearchService;
  meetingService: MeetingService;
  calendar: CalendarService;
  assistant: AssistantService;
  dictation: DictationController;
  broadcast: (channel: string, ...args: unknown[]) => void;
  startMeeting: (opts: { kind: "call" | "room"; title?: string; sourceApp?: string | null }) => Promise<RecordingState>;
  windows: { panel: BrowserWindow | null; assistant: BrowserWindow | null; openPanel(): void };
  toastAction: (action: "record" | "dismiss" | "stop") => void;
  modelsDir: () => string;
  onRecorderChunk: (id: string, samples: Float32Array) => void;
  onRecorderStarted: (id: string, err: string | null) => void;
  onRecorderStopped: (id: string) => void;
}

function handle<K extends keyof InvokeMap>(channel: K, fn: (...args: InvokeMap[K][0]) => InvokeMap[K][1] | Promise<InvokeMap[K][1]>): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as InvokeMap[K][0])));
}

/** The model for summaries/Q&A/note actions: the configured one, or local when its key is missing. */
export function smartTarget(ctx: AppContext) {
  const t = ctx.settings.get().llm.summaries;
  return ctx.llmAvailable(t.provider) ? t : { provider: "local" as const, model: "" };
}

export function meetingMarkdown(ctx: AppContext, id: string): string | null {
  const m = ctx.meetings.get(id);
  if (!m) return null;
  const speakers = Object.fromEntries(ctx.meetings.speakers(id).map((s) => [s.key, { name: s.name }]));
  return toMarkdown({ title: m.title, startedAt: m.startedAt, durationMs: m.durationMs, lines: ctx.meetings.lines(id), speakers, summary: m.summary });
}

export async function askMeetings(ctx: AppContext, meetingId: string | null, question: string): Promise<{ answer: string; cloud: boolean }> {
  const target = smartTarget(ctx);
  if (!ctx.llmAvailable(target.provider)) throw new Error("No language model is available");
  let material: string;
  if (meetingId) {
    const m = ctx.meetings.get(meetingId);
    if (!m) throw new Error("meeting not found");
    const speakers = Object.fromEntries(ctx.meetings.speakers(meetingId).map((s) => [s.key, { name: s.name }]));
    const transcript = transcriptForLlm({ lines: ctx.meetings.lines(meetingId), speakers });
    // Small local models: keep within their context window.
    const max = target.provider === "local" ? 20000 : 600000;
    material = `### ${m.title}\n${m.summary ? summaryMarkdown(m.summary) + "\n\n" : ""}${transcript.slice(0, max)}`;
  } else {
    material = await ctx.search.meetingContext(question, target.provider === "local" ? 16000 : 120000);
    if (!material) return { answer: "I couldn't find anything about that in your meetings.", cloud: false };
  }
  const r = await ctx.llm.chat(target, buildQaMessages(question, material, meetingId ? "meeting" : "all"), {
    maxTokens: 2000,
    temperature: 0.2,
    effort: "medium",
  });
  return { answer: r.text.trim(), cloud: r.cloud };
}

export function registerIpc(ctx: AppContext): void {
  const { settings, store, meetings, people, notes, broadcast } = ctx;

  ipcMain.on("recorder:chunk", (_e, id: string, samples: Float32Array) => ctx.onRecorderChunk(id, samples));
  ipcMain.on("recorder:started", (_e, id: string, err: string | null) => ctx.onRecorderStarted(id, err));
  ipcMain.on("recorder:stopped", (_e, id: string) => ctx.onRecorderStopped(id));

  // ---- settings, secrets, app ----
  handle("settings:get", () => settings.get());
  handle("settings:update", (patch) => settings.update(patch));
  handle("secrets:status", () => Object.fromEntries(SECRET_NAMES.filter((n) => !INTERNAL_SECRETS.has(n)).map((n) => [n, hasSecret(n)])));
  handle("secrets:set", (name, value) => {
    if (!SECRET_NAMES.includes(name as SecretName) || INTERNAL_SECRETS.has(name)) throw new Error("unknown secret");
    setSecret(name as SecretName, value.trim());
  });
  handle("app:info", () => {
    const exe = app.isPackaged ? process.execPath : join(app.getAppPath(), "node_modules", "electron", "dist", "electron.exe");
    const script = app.isPackaged ? join(process.resourcesPath, "app.asar", "out", "main", "mcp.js") : join(app.getAppPath(), "out", "main", "mcp.js");
    return {
      version: app.getVersion(),
      modelsDir: ctx.modelsDir(),
      userData: app.getPath("userData"),
      meetingsDir: settings.get().meetings.dir || userDataPath("meetings"),
      apiToken: settings.get().api.enabled ? apiToken() : null,
      mcpCommand: `claude mcp add nondh -e ELECTRON_RUN_AS_NODE=1 -- "${exe}" "${script}"`,
    };
  });
  handle("app:pickFolder", async () => {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle("app:deleteAllAudio", () => {
    for (const m of meetings.list({ limit: 100000 })) ctx.meetingService.deleteAudio(m);
    broadcast("meetings:changed");
  });
  handle("app:deleteEverything", () => {
    for (const m of meetings.list({ limit: 100000 })) ctx.meetingService.deleteMeeting(m);
    const db = store.db;
    db.exec(`DELETE FROM meeting_lines; DELETE FROM meeting_speakers; DELETE FROM meetings; DELETE FROM voiceprints; DELETE FROM people;
             DELETE FROM notes; DELETE FROM folders; DELETE FROM embeddings; DELETE FROM dictations; DELETE FROM dictionary;`);
    db.exec(`INSERT INTO dictations_fts(dictations_fts) VALUES ('rebuild'); INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');
             INSERT INTO meeting_lines_fts(meeting_lines_fts) VALUES ('rebuild'); VACUUM;`);
    log.info("all user data deleted");
    for (const ch of ["meetings:changed", "history:changed", "notes:changed", "people:changed"]) broadcast(ch);
  });
  handle("app:setDatabaseEncryption", (enabled) => {
    // SQLCipher re-key needs rollback-journal mode; WAL is restored afterwards.
    const db = store.db;
    db.pragma("journal_mode = DELETE");
    if (enabled) {
      const key = getSecret("db-key") ?? randomBytes(32).toString("base64");
      setSecret("db-key", key);
      db.pragma(`cipher='sqlcipher'`);
      db.pragma(`rekey='${key}'`);
    } else {
      db.pragma(`rekey=''`);
    }
    db.pragma("journal_mode = WAL");
    settings.update({ privacy: { encryptDatabase: enabled } });
    log.info(`database encryption ${enabled ? "enabled" : "disabled"}`);
  });
  handle("dictation:toggle", () => ctx.dictation.toggleFromUi());

  // ---- history & dictionary ----
  handle("history:list", (opts) => store.listDictations(opts));
  handle("history:delete", (id) => {
    store.deleteDictation(id);
    broadcast("history:changed");
  });
  handle("history:copy", async (id, which) => {
    const d = store.getDictation(id);
    if (d) await clipboard.writeText(which === "raw" ? d.rawText : d.cleanText);
  });
  handle("history:toNote", (id) => {
    const d = store.getDictation(id);
    if (!d) throw new Error("dictation not found");
    const existing = notes.bySource("dictation", id);
    if (existing) return existing;
    const title = d.cleanText.split(/[.!?\n]/)[0]!.slice(0, 60) || "Dictation";
    const n = notes.create({ title, bodyText: d.cleanText, sourceType: "dictation", sourceId: id });
    broadcast("notes:changed");
    return n;
  });
  handle("dictionary:list", () => store.listDictionary());
  handle("dictionary:upsert", (row) => store.upsertDictionary(row));
  handle("dictionary:delete", (id) => store.deleteDictionary(id));

  // ---- models ----
  handle("models:list", () => ctx.models.list());
  handle("models:download", async (id) => {
    await ctx.models.download(id).catch((err) => {
      log.error("download failed", id, err);
      throw err;
    });
    if (id === "pyannote-segmentation-3.0" || id === "campplus-speaker-embedding") ctx.speech.reload();
  });
  handle("models:cancel", (id) => ctx.models.cancel(id));
  handle("models:delete", (id) => ctx.models.delete(id));

  // ---- meetings ----
  handle("meetings:list", (opts) => meetings.list(opts));
  handle("meetings:get", async (id) => {
    const m = meetings.get(id);
    if (!m) return null;
    const calendarNames = m.attendees.length ? m.attendees : [];
    const known = people.list().filter((p) => !p.isMe).map((p) => p.name);
    return {
      meeting: m,
      lines: meetings.lines(id),
      speakers: meetings.speakers(id).map(({ embedding: _e, ...s }) => s),
      suggestions: [...new Set([...calendarNames, ...known])],
    };
  });
  handle("meetings:start", (opts) => ctx.startMeeting(opts));
  handle("meetings:stop", () => ctx.meetingService.stop());
  handle("meetings:recording", () => ctx.meetingService.recording);
  handle("meetings:rename", (id, title) => {
    meetings.update(id, { title: title.trim() || "Untitled meeting" });
    broadcast("meetings:changed");
  });
  handle("meetings:renameSpeaker", (id, key, name) => {
    const clean = name.trim();
    if (!clean) return;
    const sp = meetings.speakers(id).find((s) => s.key === key);
    if (!sp) throw new Error("speaker not found");
    let personId: string | null = null;
    if (key === "me") {
      personId = (people.me() ?? people.create(clean, true)).id;
    } else {
      const person = people.findByName(clean) ?? people.create(clean);
      personId = person.id;
      // Remember this voice so the same person is recognized in later meetings.
      if (sp.embedding) people.addVoiceprint(person.id, sp.embedding, SPEAKER_MODEL, "meeting", id);
    }
    meetings.renameSpeaker(id, key, key === "me" ? "Me" : clean, personId);
    broadcast("meetings:changed");
    broadcast("people:changed");
  });
  handle("meetings:setLineSpeaker", (id, lineId, key) => {
    meetings.setLineSpeaker(id, lineId, key);
    broadcast("meetings:changed");
  });
  handle("meetings:editLine", (id, lineId, text) => meetings.updateLineText(id, lineId, text));
  handle("meetings:summarize", (id) => ctx.meetingService.summarize(id));
  handle("meetings:ask", (id, q) => askMeetings(ctx, id, q));
  handle("meetings:export", async (id, format) => {
    const m = meetings.get(id);
    if (!m) return null;
    const speakers = Object.fromEntries(meetings.speakers(id).map((s) => [s.key, { name: s.name }]));
    const input = { title: m.title, startedAt: m.startedAt, durationMs: m.durationMs, lines: meetings.lines(id), speakers, summary: m.summary };
    const safe = m.title.replace(/[<>:"/\\|?*]+/g, " ").trim().slice(0, 80) || "meeting";
    const r = await dialog.showSaveDialog({ defaultPath: `${safe}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (r.canceled || !r.filePath) return null;
    const data =
      format === "md" ? toMarkdown(input) : format === "txt" ? toText(input) : format === "srt" ? toSrt(input) : format === "vtt" ? toVtt(input) : await toDocx(input);
    writeFileSync(r.filePath, data);
    return r.filePath;
  });
  handle("meetings:deleteAudio", (id) => {
    const m = meetings.get(id);
    if (m) ctx.meetingService.deleteAudio(m);
    broadcast("meetings:changed");
  });
  handle("meetings:delete", (id) => {
    const m = meetings.get(id);
    if (m) ctx.meetingService.deleteMeeting(m);
    notes.removeEmbeddings("meeting", id);
    broadcast("meetings:changed");
  });
  handle("meetings:reprocess", (id) => ctx.meetingService.reprocess(id));
  handle("meetings:import", async (paths) => {
    let files = paths ?? [];
    if (!files.length) {
      const r = await dialog.showOpenDialog({
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "Audio and video", extensions: ["wav", "mp3", "m4a", "aac", "ogg", "opus", "flac", "webm", "mp4", "mkv", "mov", "wma"] }],
      });
      if (r.canceled) return [];
      files = r.filePaths;
    }
    return ctx.meetingService.importFiles(files);
  });
  handle("meetings:toNote", (id) => {
    const existing = notes.bySource("meeting", id);
    if (existing) return existing;
    const m = meetings.get(id);
    if (!m) throw new Error("meeting not found");
    const body = meetingMarkdown(ctx, id) ?? "";
    const n = notes.create({ title: m.title, bodyText: body.replace(/^# .*\n+/, ""), sourceType: "meeting", sourceId: id });
    broadcast("notes:changed");
    return n;
  });
  handle("meetings:copyConsent", async () => {
    await clipboard.writeText(settings.get().meetings.consentMessage);
  });

  // ---- people ----
  handle("people:list", () => people.list());
  handle("people:rename", (id, name) => {
    people.rename(id, name);
    broadcast("people:changed");
  });
  handle("people:delete", (id) => {
    people.delete(id);
    broadcast("people:changed");
  });
  handle("people:enroll", async (name, samples) => {
    if (samples.length < 16000 * 8) throw new Error("Please read for at least 8 seconds");
    const embedding = await ctx.speech.embed(samples);
    const me = people.me() ?? people.create(name || "Me", true);
    if (name && me.name !== name) people.rename(me.id, name);
    people.clearVoiceprints(me.id, "enrollment");
    people.addVoiceprint(me.id, embedding, SPEAKER_MODEL, "enrollment");
    log.info(`voice enrolled for ${name || "me"} (${Math.round(samples.length / 16000)} s)`);
    broadcast("people:changed");
  });
  handle("toast:respond", (action) => ctx.toastAction(action));

  // ---- notes, folders, search ----
  handle("notes:list", (opts) => notes.list(opts));
  handle("notes:get", (id) => notes.get(id));
  handle("notes:create", (n) => {
    const note = notes.create(n);
    broadcast("notes:changed");
    return note;
  });
  handle("notes:update", (id, patch) => {
    const n = notes.update(id, patch);
    broadcast("notes:changed");
    return n;
  });
  handle("notes:delete", (id) => {
    notes.delete(id);
    notes.removeEmbeddings("note", id);
    broadcast("notes:changed");
  });
  handle("notes:action", async (id, action) => {
    const n = notes.get(id);
    if (!n) throw new Error("note not found");
    const target = smartTarget(ctx);
    if (!ctx.llmAvailable(target.provider)) throw new Error("No language model is available");
    const r = await ctx.llm.chat(target, noteActionMessages(action, n.title, n.bodyText), { maxTokens: 3000, temperature: 0.3, effort: "low" });
    return { text: r.text.trim(), cloud: r.cloud };
  });
  handle("folders:list", () => notes.folders());
  handle("folders:create", (name, parentId) => {
    const f = notes.createFolder(name, parentId ?? null);
    broadcast("notes:changed");
    return f;
  });
  handle("folders:rename", (id, name) => {
    notes.renameFolder(id, name);
    broadcast("notes:changed");
  });
  handle("folders:delete", (id) => {
    notes.deleteFolder(id);
    broadcast("notes:changed");
  });
  handle("search:query", async (q, opts) => {
    void ctx.search.reindex();
    return ctx.search.search(q, opts);
  });

  // ---- assistant ----
  handle("assistant:paste", () => ctx.assistant.pasteLastAnswer());
  handle("assistant:close", () => {
    ctx.windows.assistant?.hide();
  });

  // ---- calendar ----
  handle("calendar:status", () => ctx.calendar.status());
  handle("calendar:connect", (p) => ctx.calendar.connect(p));
  handle("calendar:disconnect", (p) => ctx.calendar.disconnect(p));
  handle("calendar:upcoming", () => ctx.calendar.upcoming(true));
}
