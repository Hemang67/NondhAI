import { APP_NAME } from "@shared/brand";
import { app, BrowserWindow, screen, shell } from "electron";
import { join } from "node:path";
import type { PillState } from "@shared/types";

const preload = join(__dirname, "../preload/index.js");

export function resourcePath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), "resources", name);
}

function loadRoute(win: BrowserWindow, route: string): void {
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/${route}`);
  else void win.loadFile(join(__dirname, "../renderer/index.html"), { hash: `/${route}` });
}

function denyNewWindows(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

const PILL_W = 260;
const PILL_H = 64;

/**
 * The listening indicator. It also hosts the microphone recorder, so it is created hidden at
 * startup and never destroyed. It never takes focus, so the target app keeps the caret.
 */
export function createPillWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: PILL_W,
    height: PILL_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: { preload, backgroundThrottling: false, sandbox: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true);
  loadRoute(win, "pill");
  return win;
}

export function showPill(win: BrowserWindow, state: PillState): void {
  if (win.isDestroyed()) return;
  win.webContents.send("pill:state", state);
  if (state.kind === "hidden") {
    win.hide();
    return;
  }
  if (!win.isVisible()) {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    win.setBounds({ x: Math.round(x + (width - PILL_W) / 2), y: y + height - PILL_H - 24, width: PILL_W, height: PILL_H });
    win.showInactive();
  }
}

export function createPanelWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 780,
    minHeight: 520,
    show: false,
    title: APP_NAME,
    icon: resourcePath("icon.ico"),
    backgroundColor: "#0b0d10",
    autoHideMenuBar: true,
    webPreferences: { preload, sandbox: false },
  });
  denyNewWindows(win);
  loadRoute(win, "panel");
  win.once("ready-to-show", () => win.show());
  return win;
}

/** Live transcript while a meeting is recorded. */
export function createMeetingWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: 440,
    height: 620,
    x: workArea.x + workArea.width - 460,
    y: workArea.y + 80,
    show: false,
    title: `${APP_NAME} — Recording`,
    icon: resourcePath("icon.ico"),
    backgroundColor: "#0b0d10",
    autoHideMenuBar: true,
    webPreferences: { preload, sandbox: false },
  });
  denyNewWindows(win);
  loadRoute(win, "meeting-live");
  win.once("ready-to-show", () => win.show());
  return win;
}

/**
 * The always-visible recording indicator. It cannot be closed while recording; clicking it
 * opens the live window.
 */
export function createRecIndicator(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: 190,
    height: 44,
    x: workArea.x + Math.round(workArea.width / 2) - 95,
    y: workArea.y + 8,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    closable: false,
    hasShadow: false,
    show: false,
    webPreferences: { preload, sandbox: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true);
  loadRoute(win, "rec");
  win.once("ready-to-show", () => win.showInactive());
  return win;
}

/** "Meeting detected — Start Capturing" prompt in the top-right corner. */
export function createToastWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: 380,
    height: 160,
    x: workArea.x + workArea.width - 396,
    y: workArea.y + 16,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    focusable: true,
    webPreferences: { preload, sandbox: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  loadRoute(win, "toast");
  return win;
}

/** Floating answer panel for the voice assistant. */
export function createAssistantWindow(): BrowserWindow {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workArea } = display;
  const win = new BrowserWindow({
    width: 520,
    height: 420,
    x: workArea.x + Math.round((workArea.width - 520) / 2),
    y: workArea.y + Math.round(workArea.height / 5),
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload, sandbox: false },
  });
  denyNewWindows(win);
  loadRoute(win, "assistant");
  return win;
}

/** Hidden window that runs screen capture (MediaRecorder); never throttled in the background. */
export function createScreenRecorderWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    skipTaskbar: true,
    webPreferences: { preload, sandbox: false, backgroundThrottling: false },
  });
  loadRoute(win, "screen-recorder");
  return win;
}

/** Full-screen overlay on one display for dragging out a region to record. */
export function createRegionWindow(display: Electron.Display): BrowserWindow {
  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload, sandbox: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setContentProtection(true); // the selection overlay itself never appears in recordings
  loadRoute(win, "region");
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  return win;
}

/**
 * The app's own on-screen controls are excluded from screen recordings (and from screen
 * sharing in other apps) on Windows 10 2004+.
 */
export function excludeFromCapture(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) win.setContentProtection(true);
}
