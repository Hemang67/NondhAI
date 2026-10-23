import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";
import { Updater } from "./updater";
import { dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { MeetingRecord, PillState } from "@shared/types";
import { buildCleanupMessages } from "@shared/cleanup/llmCleanup";
import { SettingsStore } from "./settingsStore";
import { modelsDir as resolveModelsDir, userDataPath } from "./paths";
import { adoptEarlierDatabase, Store } from "./storage/store";
import { ClipRepo, MeetingRepo, PeopleRepo } from "./storage/meetings";
import { ScreenRecorder } from "./screen/screenRecorder";
import { MediaServer } from "./mediaServer";
import { APP_NAME, TAGLINE } from "@shared/brand";
import { LIBRARY } from "@shared/video/project";
import { LibraryVideoRepo, VideoProjectRepo } from "./storage/videoProjects";
import { VideoService } from "./video/videoService";
import { NotesRepo } from "./storage/notes";
import { getSecret, hasSecret, type SecretName } from "./secrets";
import { InputHelper } from "./native/inputHelper";
import { SpeechService } from "./speech/speechService";
import { LlamaServer } from "./llm/llamaServer";
import { LlmClient } from "./llm/llm";
import { ModelManager } from "./models/modelManager";
import { DictationController } from "./dictation/dictationController";
import { MeetingService } from "./meeting/meetingService";
import { MeetingDetector } from "./meeting/meetingDetector";
import { readAudio } from "./meeting/audioFiles";
import { SearchService } from "./search/searchService";
import { AssistantService } from "./assistant/assistantService";
import { CalendarService } from "./calendar/calendarService";
import { ApiServer } from "./api/apiServer";
import { registerApiRoutes } from "./api/routes";
import { registerIpc, type AppContext } from "./ipc";
import {
  createAssistantWindow,
  createMeetingWindow,
  createPanelWindow,
  createPillWindow,
  createRecIndicator,
  createToastWindow,
  excludeFromCapture,
  resourcePath,
  showPill,
} from "./windows";
import { log } from "./log";

const HIDDEN_FLAG = "--hidden";

// Test-only switches for end-to-end runs without a person at the microphone:
// NONDH_FAKE_MIC=<wav> feeds a file to getUserMedia; NONDH_E2E=1 lets the key hook
// accept synthetic key presses. Neither is set in normal use.
if (process.env.NONDH_FAKE_MIC) {
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-file-for-fake-audio-capture", process.env.NONDH_FAKE_MIC);
}
// NONDH_DEBUG_PORT=<port> lets test scripts drive the UI over the Chrome DevTools protocol
// (localhost only). Never set in normal use.
// NONDH_USER_DATA=<dir> runs against a separate profile (test data never touches yours).
if (process.env.NONDH_USER_DATA) app.setPath("userData", process.env.NONDH_USER_DATA);
if (process.env.NONDH_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.NONDH_DEBUG_PORT);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}


if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => windows.openPanel());
  app.setAppUserModelId("com.nondh.ai");
  void app.whenReady().then(main);
}

let quitting = false;
let tray: Tray;

/** Lazily created windows; each is reused while it exists. */
const windows = {
  panel: null as BrowserWindow | null,
  meeting: null as BrowserWindow | null,
  rec: null as BrowserWindow | null,
  toast: null as BrowserWindow | null,
  assistant: null as BrowserWindow | null,
  openPanel(): void {
    const w = this.panel;
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      return;
    }
    this.panel = createPanelWindow();
    this.panel.on("close", (e) => {
      // Closing the window keeps the app in the tray.
      if (!quitting) {
        e.preventDefault();
        this.panel?.hide();
      }
    });
  },
};

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}

function applyLoginItem(enabled: boolean): void {
  // A dev build would register electron.exe; a test run (separate profile) must not touch the real entry.
  if (!app.isPackaged || process.env.NONDH_USER_DATA) return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_FLAG] });
}

async function main(): Promise<void> {
  // Windows ask for the media server's address when they first play something; it starts
  // further down, once everything it serves from exists.
  const mediaBase = { url: "" };
  ipcMain.on("media:base", (e) => (e.returnValue = mediaBase.url));
  const settings = new SettingsStore();
  const modelsDir = () => resolveModelsDir(settings.get().modelsDir);
  const dbKey = settings.get().privacy.encryptDatabase ? getSecret("db-key") : null;
  adoptEarlierDatabase(userDataPath("nondh.db"));
  const store = new Store(userDataPath("nondh.db"), { key: dbKey ?? undefined });
  const meetings = new MeetingRepo(store.db);
  const people = new PeopleRepo(store.db);
  const notes = new NotesRepo(store.db);
  const input = new InputHelper(process.env.NONDH_E2E === "1" ? ["--accept-injected"] : []);
  const speech = new SpeechService(() => settings.get(), modelsDir);
  const llama = new LlamaServer("chat");
  const embedServer = new LlamaServer("embedding");
  const llm = new LlmClient(llama, () => settings.get(), modelsDir);
  const models = new ModelManager(modelsDir);
  const calendar = new CalendarService(() => settings.get());
  const search = new SearchService({ embedServer, modelsDir, notes, meetings, store });

  const llmAvailable = (provider: string) => {
    if (provider === "local") return existsSync(join(modelsDir(), "llm", settings.get().llm.localModel));
    if (provider === "custom") return !!settings.get().llm.customBaseUrl;
    return hasSecret(provider as SecretName);
  };

  const pill = createPillWindow();
  excludeFromCapture(pill);
  const setPill = (s: PillState) => {
    if (!settings.get().ui.showPill && s.kind !== "error") pill.webContents.send("pill:state", s);
    else showPill(pill, s);
    updateTray();
  };

  const assistantWindow = () => {
    if (!windows.assistant || windows.assistant.isDestroyed()) windows.assistant = createAssistantWindow();
    return windows.assistant;
  };
  const assistant = new AssistantService({ settings: () => settings.get(), input, llm, llmAvailable, window: assistantWindow });

  const pending = new Map<string, { started?: (err: string | null) => void; stopped?: () => void }>();
  const dictation = new DictationController({
    settings: () => settings.get(),
    input,
    speech,
    llm,
    store,
    setPill,
    llmAvailable: () => llmAvailable(settings.get().cleanup.llm.provider),
    onDictation: () => broadcast("history:changed"),
    assistant,
    recorder: {
      start: (id) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("recorder did not start")), 5000);
          pending.set(id, {
            started: (err) => {
              clearTimeout(timer);
              if (err) reject(new Error(err));
              else resolve();
            },
          });
          pill.webContents.send("recorder:start", id);
        }),
      stop: (id) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1500);
          pending.set(id, {
            stopped: () => {
              clearTimeout(timer);
              resolve();
            },
          });
          pill.webContents.send("recorder:stop", id);
        }),
    },
  });

  const clips = new ClipRepo(store.db);
  const meetingService = new MeetingService({ settings: () => settings.get(), speech, meetings, people, clips, llm, llmAvailable });
  const screenRecorder = new ScreenRecorder({
    clips,
    meetings,
    recording: () => meetingService.recording,
    encrypt: () => settings.get().meetings.encryptAudio,
  });
  screenRecorder.on("state", (s) => {
    broadcast("screen:state", s);
    updateTray();
  });
  screenRecorder.on("changed", () => broadcast("meetings:changed"));
  const libraryVideos = new LibraryVideoRepo(store.db);
  const video = new VideoService({
    videos: new VideoProjectRepo(store.db),
    library: libraryVideos,
    libraryDir: userDataPath("library"),
    clips,
    meetings,
    encrypt: () => settings.get().meetings.encryptAudio,
    transcribe: (pcm, onProgress) => speech.finalPass(pcm, "mixed", onProgress),
  });
  video.on("changed", () => broadcast("video:changed"));
  video.on("progress", (id: string, p: unknown) => broadcast("video:progress", id, p));
  meetingService.on("audioDeleted", (m: MeetingRecord) => {
    video.deleteExports(m);
    broadcast("video:changed");
  });
  // The app's own folder (vd-audio, the dev Electron) never triggers the prompt.
  const selfDir = app.isPackaged ? dirname(process.execPath) : app.getAppPath();
  const detector = new MeetingDetector(process.execPath, () => ({
    anyApp: settings.get().meetings.detectAnyApp,
    ignorePaths: [join(selfDir, "/")],
  }));

  // ---- meeting windows and indicator ----
  // The popup window is created hidden at startup and reused, so it is fully loaded before the
  // first detection (showing a window that is still loading left it invisible).
  let toastReady: Promise<BrowserWindow>;
  const makeToast = () => {
    const t = createToastWindow();
    windows.toast = t;
    excludeFromCapture(t);
    toastReady = new Promise((resolve) => t.webContents.once("did-finish-load", () => resolve(t)));
  };
  makeToast();
  const showToast = (info: { kind: "detected" | "ended"; app: string }) => {
    if (!windows.toast || windows.toast.isDestroyed()) makeToast();
    void toastReady.then((t) => {
      t.webContents.send("toast:show", info);
      t.setAlwaysOnTop(true, "screen-saver");
      t.showInactive();
      t.moveTop();
    });
  };
  let detectedApp: string | null = null;
  detector.on("started", (appName: string) => {
    if (meetingService.recording || !settings.get().meetings.autoDetect) return;
    detectedApp = appName;
    showToast({ kind: "detected", app: appName });
  });
  detector.on("ended", (appName: string) => {
    if (meetingService.recording) showToast({ kind: "ended", app: appName });
  });

  const startMeeting = async (opts: { kind: "call" | "room"; title?: string; sourceApp?: string | null }) => {
    const ev = await calendar.current().catch(() => null);
    const state = await meetingService.start({ ...opts, title: opts.title || ev?.title });
    if (ev) meetings.update(state.id, { attendees: ev.attendees, calendarEventId: ev.id });
    return state;
  };
  meetingService.on("state", (state) => {
    broadcast("meeting:state", state);
    updateTray();
    if (state) {
      if (!windows.rec || windows.rec.isDestroyed()) windows.rec = createRecIndicator();
      if (!windows.meeting || windows.meeting.isDestroyed()) windows.meeting = createMeetingWindow();
      // Keep the app's own controls out of screen recordings and other apps' screen shares.
      excludeFromCapture(windows.rec);
      excludeFromCapture(windows.meeting);
    } else {
      // A screen clip never outlives its meeting.
      void screenRecorder.stop();
      // The indicator only goes away once recording has really stopped.
      windows.rec?.destroy();
      windows.rec = null;
    }
  });
  meetingService.on("line", (id: string, line: unknown) => broadcast("meeting:line", id, line));
  meetingService.on("level", (mic: number, sys: number) => {
    windows.meeting?.webContents.send("meeting:level", mic, sys);
    windows.rec?.webContents.send("meeting:level", mic, sys);
  });
  meetingService.on("progress", (id: string, text: string) => broadcast("meeting:progress", id, text));
  meetingService.on("changed", () => {
    broadcast("meetings:changed");
    void search.reindex();
  });
  meetingService.on("error", (msg: string) => broadcast("meeting:progress", meetingService.recording?.id ?? "", `Audio error: ${msg}`));

  // ---- media for the app's players (meeting audio, screen clips, edits, added images) ----
  // Decrypting is the slow part; keep the last few files in memory so seeking (and the editor
  // playing a clip with the meeting audio) doesn't redo it.
  const mediaCache: Array<{ path: string; data: Buffer }> = [];
  const decrypted = (path: string): Buffer => {
    // Keyed by modification time too, so a re-exported edit isn't served from the cache.
    const key = `${path}|${statSync(path).mtimeMs}`;
    const i = mediaCache.findIndex((c) => c.path === key);
    const hit = i >= 0 ? mediaCache.splice(i, 1)[0]! : { path: key, data: readAudio(path) };
    mediaCache.unshift(hit);
    mediaCache.length = Math.min(mediaCache.length, 3);
    return hit.data;
  };
  const TYPES: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", wma: "audio/x-ms-wma",
  };
  // <base>/<meetingId>             → the meeting audio
  // <base>/<meetingId>/<clipId>    → a screen clip
  // <base>/<meetingId>/edit/<id>   → an exported edit
  // <base>/<meetingId>/asset/<f>   → an image or audio file added to an edit
  const mediaServer = new MediaServer({
    decrypt: decrypted,
    resolve: (meetingId, [first = "", second = ""]) => {
      if (meetingId === LIBRARY) {
        // Imported videos, their edits' exports and added files, in the library folder.
        const dir = userDataPath("library");
        let file: string | null | undefined = null;
        let type = "video/mp4";
        if (first === "edit") {
          const p = video.get(second)?.project;
          file = p && p.meetingId === null ? p.exportFile : null;
        } else if (first === "asset") {
          file = /^[\w-]+\.\w+$/.test(second) ? join("video-assets", second) : null;
          type = TYPES[second.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
        } else if (first) {
          file = libraryVideos.get(first)?.file;
          if (file?.endsWith(".webm")) type = "video/webm";
        }
        return file ? { path: join(dir, file), type, encrypted: file.endsWith(".enc") } : null;
      }
      const m = meetings.get(meetingId);
      if (!m) return null;
      let file: string | null | undefined = null;
      let type = "audio/ogg";
      if (!first) file = m.audioFile;
      else if (first === "edit") {
        const p = video.get(second)?.project;
        file = p?.meetingId === m.id ? p.exportFile : null;
        type = "video/mp4";
      } else if (first === "asset") {
        // Only plain file names inside the meeting's asset folder.
        file = /^[\w-]+\.\w+$/.test(second) ? join("video-assets", second) : null;
        type = TYPES[second.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
      } else {
        const clip = clips.get(first);
        file = clip?.meetingId === m.id ? clip.file : null;
        type = "video/webm";
      }
      return file ? { path: join(m.dir, file), type, encrypted: file.endsWith(".enc") } : null;
    },
  });
  mediaBase.url = await mediaServer.start();
  app.on("will-quit", () => mediaServer.stop());

  // ---- IPC ----
  const ctx: AppContext = {
    settings,
    store,
    meetings,
    people,
    notes,
    speech,
    llm,
    llmAvailable,
    models,
    search,
    meetingService,
    calendar,
    assistant,
    screenRecorder,
    clips,
    video,
    dictation,
    broadcast,
    startMeeting,
    windows,
    toastAction: (action) => {
      windows.toast?.hide();
      if (action === "record") void startMeeting({ kind: "call", sourceApp: detectedApp });
      if (action === "stop") void meetingService.stop();
    },
    modelsDir,
    onRecorderChunk: (id, samples) => dictation.onAudio(id, samples),
    onRecorderStarted: (id, err) => pending.get(id)?.started?.(err),
    onRecorderStopped: (id) => {
      pending.get(id)?.stopped?.();
      pending.delete(id);
    },
  };
  registerIpc(ctx);
  models.on("progress", () => broadcast("models:changed"));

  // ---- updates ----
  const updater = new Updater((s) => broadcast("updates:status", s));
  ipcMain.handle("updates:status", () => updater.status);
  ipcMain.handle("updates:check", () => updater.check());
  ipcMain.handle("updates:install", () => updater.installNow());
  updater.configure(settings.get().updates.auto, settings.get().updates.feedUrl);

  // ---- local API ----
  const api = new ApiServer();
  registerApiRoutes(api, ctx);
  const applyApi = async () => {
    const s = settings.get().api;
    if (s.enabled) await api.start(s.port).catch((e) => log.error("local API failed to start", e));
    else api.stop();
  };

  // ---- settings side effects ----
  const bindHotkeys = () => {
    const h = settings.get().hotkeys;
    input.setBindings({ dictate: h.dictate, translate: h.translate, assistant: h.assistant, meeting: h.meeting });
  };
  input.on("chord", (kind: string, name: string) => {
    if (name !== "meeting" || kind !== "down") return;
    if (meetingService.recording) void meetingService.stop();
    else void startMeeting({ kind: "call" });
  });
  settings.on("change", (next, prev) => {
    if (JSON.stringify(next.hotkeys) !== JSON.stringify(prev.hotkeys)) bindHotkeys();
    if (
      next.stt.engine !== prev.stt.engine ||
      next.stt.parakeetModel !== prev.stt.parakeetModel ||
      next.stt.whisperModel !== prev.stt.whisperModel ||
      next.modelsDir !== prev.modelsDir
    ) {
      speech.reload();
      void speech.warm().catch((e) => log.warn("speech warm-up failed", e));
    }
    if (next.llm.localModel !== prev.llm.localModel || next.llm.localGpu !== prev.llm.localGpu) llama.stop();
    if (next.launchAtLogin !== prev.launchAtLogin) applyLoginItem(next.launchAtLogin);
    if (next.meetings.autoDetect !== prev.meetings.autoDetect) {
      if (next.meetings.autoDetect) detector.start();
      else detector.stop();
    }
    if (JSON.stringify(next.api) !== JSON.stringify(prev.api)) void applyApi();
    if (next.updates.feedUrl !== prev.updates.feedUrl || next.updates.auto !== prev.updates.auto) updater.configure(next.updates.auto, next.updates.feedUrl);
  });

  // ---- tray ----
  tray = new Tray(nativeImage.createFromPath(resourcePath("tray.png")));
  tray.setToolTip(`${APP_NAME} — ${TAGLINE}`);
  tray.on("click", () => windows.openPanel());
  function updateTray(): void {
    const recording = !!meetingService.recording;
    tray.setImage(resourcePath(recording ? "tray-recording.png" : "tray.png"));
    tray.setToolTip(recording ? `${APP_NAME} — recording a meeting` : `${APP_NAME} — ${TAGLINE}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${APP_NAME}`, click: () => windows.openPanel() },
        { label: "Start / stop dictation", click: () => dictation.toggleFromUi() },
        { type: "separator" },
        recording
          ? { label: "Stop recording meeting", click: () => void meetingService.stop() }
          : { label: "Record a call", click: () => void startMeeting({ kind: "call" }) },
        ...(recording ? [] : [{ label: "Record an in-person meeting", click: () => void startMeeting({ kind: "room" }) }]),
        ...(screenRecorder.state ? [{ label: "Stop screen recording", click: () => void screenRecorder.stop() }] : []),
        { type: "separator" },
        {
          label: "Quit",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
  }
  updateTray();

  input.start();
  bindHotkeys();
  applyLoginItem(settings.get().launchAtLogin);
  void applyApi();
  if (settings.get().meetings.autoDetect) detector.start();

  let stopping = false;
  app.on("before-quit", (e) => {
    quitting = true;
    if (meetingService.recording && !stopping) {
      // Finish writing the recording before exiting; processing resumes at next start.
      e.preventDefault();
      stopping = true;
      void meetingService.stop().finally(() => app.quit());
      return;
    }
    input.stop();
    detector.stop();
    speech.stop();
    llama.stop();
    embedServer.stop();
    api.stop();
    store.close();
  });
  app.on("window-all-closed", () => {
    // Stay resident in the tray.
  });

  if (!process.argv.includes(HIDDEN_FLAG)) windows.openPanel();

  // Background start-up work: models, warm-up, crash recovery, retention, search index.
  void (async () => {
    try {
      await models.ensureRequired();
      await speech.warm();
      log.info("speech engine ready");
      meetingService.recover();
      await screenRecorder.recover();
      meetingService.applyRetention();
      setInterval(() => meetingService.applyRetention(), 6 * 3600 * 1000);
      if (settings.get().cleanup.llm.provider === "local" && llmAvailable("local")) {
        const s = settings.get();
        await llama.ensure(join(modelsDir(), "llm", s.llm.localModel), s.llm.localGpu);
        // Process the fixed cleanup prompt once so later calls only pay for the new words.
        const t0 = Date.now();
        const terms = store.listDictionary().map((d) => d.term);
        await llm.chat({ provider: "local", model: "" }, buildCleanupMessages("Warm up.", { terms }), { maxTokens: 1 });
        log.info(`cleanup prompt cached in ${Date.now() - t0} ms`);
      }
      await search.reindex();
      setInterval(() => void search.reindex(), 10 * 60 * 1000);
    } catch (err) {
      log.error("warm-up failed", err);
    }
  })();
  log.info(`${APP_NAME} ${app.getVersion()} started; models at ${modelsDir()}`);
}
