import { clipboard, ClipboardItem } from "electron";
import type { InputHelper, ForegroundInfo } from "./native/inputHelper";
import { log } from "./log";

/** Every MIME type of every clipboard entry, so images, HTML and rich text come back intact. */
type ClipboardSnapshot = Array<Record<string, Blob>>;

async function snapshot(): Promise<ClipboardSnapshot> {
  const items = await clipboard.read();
  const out: ClipboardSnapshot = [];
  for (const item of items) {
    const entry: Record<string, Blob> = {};
    for (const type of item.types) {
      if (type === "electron application/bookmark") continue;
      try {
        entry[type] = (await item.getType(type)) as Blob;
      } catch {
        // a format that can't be read back is skipped rather than failing the paste
      }
    }
    if (Object.keys(entry).length) out.push(entry);
  }
  return out;
}

async function restore(s: ClipboardSnapshot): Promise<void> {
  if (!s.length) {
    clipboard.clear();
    return;
  }
  await clipboard.write(s.map((entry) => new ClipboardItem(entry)));
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
  const saved = opts.restoreClipboard ? await snapshot().catch(() => null) : null;
  await clipboard.writeText(text);
  const shift = !!opts.target && SHIFT_PASTE_APPS.has(opts.target.appName.toLowerCase());
  const r = await input.paste(shift);
  if (r !== "ok") {
    // Leave the text on the clipboard so the user can paste it themselves.
    return { pasted: false, reason: r };
  }
  if (saved) {
    setTimeout(() => {
      void (async () => {
        if ((await clipboard.readText()) === text) await restore(saved);
      })().catch((err) => log.warn("clipboard restore failed", err));
    }, opts.restoreDelayMs);
  }
  return { pasted: true };
}
