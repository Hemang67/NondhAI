import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Tray } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { InvokeMap } from "@shared/ipc";
import type { PillState } from "@shared/types";
import { buildCleanupMessages } from "@shared/cleanup/llmCleanup";
import { SettingsStore } from "./settingsStore";
import { modelsDir as resolveModelsDir, userDataPath } from "./paths";
import { Store } from "./storage/store";
import { getSecret, hasSecret, setSecret, SECRET_NAMES, type SecretName } from "./secrets";
import { InputHelper } from "./native/inputHelper";
import { SpeechService } from "./speech/speechService";
import { LlamaServer } from "./llm/llamaServer";
import { LlmClient } from "./llm/llm";
import { ModelManager } from "./models/modelManager";
import { DictationController } from "./dictation/dictationController";
import { createPanelWindow, createPillWindow, showPill } from "./windows";
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => openPanel());
  app.setAppUserModelId("com.nondh.app");
  void app.whenReady().then(main);
}

let panel: BrowserWindow | null = null;
let pill: BrowserWindow;
let tray: Tray;
let quitting = false;

function resource(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), "resources", name);
}

function openPanel(): void {
  if (panel && !panel.isDestroyed()) {
    if (panel.isMinimized()) panel.restore();
    panel.show();
    panel.focus();
    return;
  }
  panel = createPanelWindow();
  panel.on("close", (e) => {
    // Closing the window keeps the app in the tray.
    if (!quitting) {
      e.preventDefault();
      panel?.hide();
    }
  });
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}

function handle<K extends keyof InvokeMap>(channel: K, fn: (...args: InvokeMap[K][0]) => InvokeMap[K][1] | Promise<InvokeMap[K][1]>): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as InvokeMap[K][0])));
}

function applyLoginItem(enabled: boolean): void {
  if (!app.isPackaged) return; // a dev build would register electron.exe
  app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_FLAG] });
}

async function main(): Promise<void> {
  const settings = new SettingsStore();
  const modelsDir = () => resolveModelsDir(settings.get().modelsDir);
  const dbKey = getSecret("db-key");
  const store = new Store(userDataPath("nondh.db"), { key: dbKey ?? undefined });
  const input = new InputHelper(process.env.NONDH_E2E === "1" ? ["--accept-injected"] : []);
  const speech = new SpeechService(() => settings.get(), modelsDir);
  const llama = new LlamaServer();
  const llm = new LlmClient(llama, () => settings.get(), modelsDir);
  const models = new ModelManager(modelsDir);
  models.on("progress", () => broadcast("models:changed"));

  pill = createPillWindow();
  const pending = new Map<string, { started?: (err: string | null) => void; stopped?: () => void }>();

  const setPill = (s: PillState) => {
    if (!settings.get().ui.showPill && s.kind !== "error") {
      pill.webContents.send("pill:state", s);
    } else {
      showPill(pill, s);
    }
    tray?.setImage(resource(s.kind === "listening" ? "tray-recording.png" : "tray.png"));
  };

  const llmAvailable = () => {
    const s = settings.get();
    const t = s.cleanup.llm;
    if (t.provider === "local") return existsSync(join(modelsDir(), "llm", s.llm.localModel));
    return hasSecret(t.provider as SecretName);
  };

  const dictation = new DictationController({
    settings: () => settings.get(),
    input,
    speech,
    llm,
    store,
    setPill,
    llmAvailable,
    onDictation: () => broadcast("history:changed"),
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

  ipcMain.on("recorder:chunk", (_e, id: string, samples: Float32Array) => dictation.onAudio(id, samples));
  ipcMain.on("recorder:started", (_e, id: string, err: string | null) => pending.get(id)?.started?.(err));
  ipcMain.on("recorder:stopped", (_e, id: string) => {
    pending.get(id)?.stopped?.();
    pending.delete(id);
  });

  // ---- IPC ----
  handle("settings:get", () => settings.get());
  handle("settings:update", (patch) => settings.update(patch));
  handle("secrets:status", () => Object.fromEntries(SECRET_NAMES.filter((n) => n !== "db-key").map((n) => [n, hasSecret(n)])));
  handle("secrets:set", (name, value) => {
    if (!SECRET_NAMES.includes(name as SecretName) || name === "db-key") throw new Error("unknown secret");
    setSecret(name as SecretName, value.trim());
  });
  handle("history:list", (opts) => store.listDictations(opts));
  handle("history:delete", (id) => {
    store.deleteDictation(id);
    broadcast("history:changed");
  });
  handle("history:copy", async (id, which) => {
    const d = store.getDictation(id);
    if (d) await clipboard.writeText(which === "raw" ? d.rawText : d.cleanText);
  });
  handle("dictionary:list", () => store.listDictionary());
  handle("dictionary:upsert", (row) => store.upsertDictionary(row));
  handle("dictionary:delete", (id) => store.deleteDictionary(id));
  handle("models:list", () => models.list());
  handle("models:download", (id) =>
    models.download(id).catch((err) => {
      log.error("download failed", id, err);
      throw err;
    }),
  );
  handle("models:cancel", (id) => models.cancel(id));
  handle("models:delete", (id) => models.delete(id));
  handle("app:info", () => ({ version: app.getVersion(), modelsDir: modelsDir(), userData: app.getPath("userData") }));
  handle("app:pickModelsDir", async () => {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle("dictation:toggle", () => dictation.toggleFromUi());

  // ---- settings side effects ----
  const bindHotkeys = () => {
    const h = settings.get().hotkeys;
    // The assistant chord is wired up in Phase 3; meeting in Phase 2.
    input.setBindings({ dictate: h.dictate, translate: h.translate });
  };
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
  });

  // ---- tray ----
  tray = new Tray(nativeImage.createFromPath(resource("tray.png")));
  tray.setToolTip("Nondh AI");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Nondh AI", click: openPanel },
      { label: "Start / stop dictation", click: () => dictation.toggleFromUi() },
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
  tray.on("click", openPanel);

  input.start();
  bindHotkeys();
  applyLoginItem(settings.get().launchAtLogin);

  app.on("before-quit", () => {
    quitting = true;
    input.stop();
    speech.stop();
    llama.stop();
    store.close();
  });
  app.on("window-all-closed", () => {
    // Stay resident in the tray.
  });

  if (!process.argv.includes(HIDDEN_FLAG)) openPanel();

  // Warm models in the background so the first dictation is fast.
  void (async () => {
    try {
      await models.ensureRequired();
      await speech.warm();
      log.info("speech engine ready");
      if (settings.get().cleanup.llm.provider === "local" && llmAvailable()) {
        const s = settings.get();
        await llama.ensure(join(modelsDir(), "llm", s.llm.localModel), s.llm.localGpu);
        // Process the fixed cleanup prompt once so later calls only pay for the new words.
        const t0 = Date.now();
        await llm.chat({ provider: "local", model: "" }, buildCleanupMessages("Warm up.", { terms: store.listDictionary().map((d) => d.term) }), { maxTokens: 1 });
        log.info(`cleanup prompt cached in ${Date.now() - t0} ms`);
      }
    } catch (err) {
      log.error("warm-up failed", err);
    }
  })();
  log.info(`Nondh AI ${app.getVersion()} started; models at ${modelsDir()}`);
}
