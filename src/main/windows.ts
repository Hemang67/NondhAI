import { BrowserWindow, screen, shell } from "electron";
import { join } from "node:path";
import type { PillState } from "@shared/types";

const preload = join(__dirname, "../preload/index.js");

function loadRoute(win: BrowserWindow, route: string): void {
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/${route}`);
  else void win.loadFile(join(__dirname, "../renderer/index.html"), { hash: `/${route}` });
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
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: "Nondh AI",
    icon: join(__dirname, "../../resources/icon.ico"),
    backgroundColor: "#0b0d10",
    autoHideMenuBar: true,
    webPreferences: { preload, sandbox: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  loadRoute(win, "panel");
  win.once("ready-to-show", () => win.show());
  return win;
}
