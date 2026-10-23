import { clipboard, type NativeImage } from "electron";
import type { InputHelper, ForegroundInfo } from "./native/inputHelper";

interface ClipboardSnapshot {
  text: string;
  html: string;
  rtf: string;
  image: NativeImage | null;
  empty: boolean;
}

function snapshot(): ClipboardSnapshot {
  const formats = clipboard.availableFormats();
  const image = formats.some((f) => f.startsWith("image/")) ? clipboard.readImage() : null;
  return {
    text: clipboard.readText(),
    html: formats.includes("text/html") ? clipboard.readHTML() : "",
    rtf: formats.includes("text/rtf") ? clipboard.readRTF() : "",
    image: image && !image.isEmpty() ? image : null,
    empty: formats.length === 0,
  };
}

function restore(s: ClipboardSnapshot): void {
  if (s.empty) {
    clipboard.clear();
    return;
  }
  const data: Electron.Data = {};
  if (s.text) data.text = s.text;
  if (s.html) data.html = s.html;
  if (s.rtf) data.rtf = s.rtf;
  if (s.image) data.image = s.image;
  clipboard.write(data);
}

// Terminals where Ctrl+V is not paste.
const SHIFT_PASTE_APPS = new Set(["windowsterminal", "wt", "mintty", "alacritty", "wezterm-gui", "conhost"]);

export interface PasteResult {
  pasted: boolean;
  reason?: string;
}

/**
 * Put text on the clipboard, send the paste chord to the focused app, then put the user's
 * previous clipboard back — unless they copied something new in the meantime.
 */
export async function pasteText(
  input: InputHelper,
  text: string,
  opts: { restoreClipboard: boolean; restoreDelayMs: number; target?: ForegroundInfo | null },
): Promise<PasteResult> {
  const saved = opts.restoreClipboard ? snapshot() : null;
  clipboard.writeText(text);
  const shift = !!opts.target && SHIFT_PASTE_APPS.has(opts.target.appName.toLowerCase());
  const r = await input.paste(shift);
  if (r !== "ok") {
    // Leave the text on the clipboard so the user can paste it themselves.
    return { pasted: false, reason: r };
  }
  if (saved) {
    setTimeout(() => {
      if (clipboard.readText() === text) restore(saved);
    }, opts.restoreDelayMs);
  }
  return { pasted: true };
}
