import { APP_NAME } from "./brand";

/** The app's name before it was renamed; folders named after it ("Nondh AI-data") get the new name. */
const OLD_NAME = /^voice[- ]?desk(?![a-z0-9])/i;

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "");

/**
 * For folders the user picked (models, recordings), the part of the path named after the old app
 * name and what it becomes: "D:/Nondh AI-data/models" → { from: "D:\Nondh AI-data", to: "D:\Nondh AI-data" }.
 */
export function legacyRoots(paths: string[]): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const p of paths) {
    if (!p) continue;
    const parts = norm(p).split("\\");
    // Only the chosen folder itself or its parent ("D:\Nondh AI-data\models"), never a folder
    // further up that merely shares the name (a project folder, a user folder…).
    const last = parts.length - 1;
    const i = [last, last - 1].find((k) => k > 0 && OLD_NAME.test(parts[k]!));
    if (i === undefined) continue;
    const from = parts.slice(0, i + 1).join("\\");
    const to = [...parts.slice(0, i), parts[i]!.replace(OLD_NAME, APP_NAME)].join("\\");
    if (!out.some((r) => r.from.toLowerCase() === from.toLowerCase())) out.push({ from, to });
  }
  return out;
}

/** `p` moved from under `from` to under `to` (Windows paths, any slash style, any case); else unchanged. */
export function swapRoot(p: string, from: string, to: string): string {
  if (!p) return p;
  const n = norm(p);
  const f = norm(from);
  if (n.toLowerCase() === f.toLowerCase()) return norm(to);
  if (n.toLowerCase().startsWith(f.toLowerCase() + "\\")) return norm(to) + n.slice(f.length);
  return p;
}
