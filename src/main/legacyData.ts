import { app } from "electron";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { SettingsStore } from "./settingsStore";

/**
 * The app used to be called Nondh AI and kept its data in %APPDATA%\Nondh AI. On the first
 * start under the new name, that folder (database, recordings, models, keys, settings) is moved
 * to the new data folder. Imported first in index.ts, so it runs before anything creates files
 * in the new folder.
 */
export const LEGACY_DATA_DIR = join(app.getPath("appData"), "Nondh AI");

if (!process.env.NONDH_USER_DATA) {
  const dest = app.getPath("userData");
  if (existsSync(join(LEGACY_DATA_DIR, "nondh.db")) && !existsSync(join(dest, "nondh.db"))) {
    try {
      renameSync(LEGACY_DATA_DIR, dest);
    } catch {
      // The new folder already exists (or something is in use): move what can be moved.
      mkdirSync(dest, { recursive: true });
      for (const name of readdirSync(LEGACY_DATA_DIR)) {
        try {
          renameSync(join(LEGACY_DATA_DIR, name), join(dest, name));
        } catch {
          /* left behind; the old folder is kept */
        }
      }
    }
  }
}

const under = (p: string, dir: string) => p.toLowerCase().startsWith(dir.toLowerCase() + "\\") || p.toLowerCase() === dir.toLowerCase();

/** Points stored paths that still lead into the old folder at the new one. Safe to run on every start. */
export function fixLegacyPaths(db: Database.Database, settings: SettingsStore): void {
  const dest = app.getPath("userData");
  if (dest.toLowerCase() === LEGACY_DATA_DIR.toLowerCase()) return;
  const rows = db.prepare(`SELECT id, dir FROM meetings`).all() as Array<{ id: string; dir: string }>;
  const update = db.prepare(`UPDATE meetings SET dir = ? WHERE id = ?`);
  for (const r of rows) if (under(r.dir, LEGACY_DATA_DIR)) update.run(dest + r.dir.slice(LEGACY_DATA_DIR.length), r.id);

  const s = settings.get();
  const move = (p: string) => (p && under(p, LEGACY_DATA_DIR) ? dest + p.slice(LEGACY_DATA_DIR.length) : p);
  if (move(s.modelsDir) !== s.modelsDir || move(s.meetings.dir) !== s.meetings.dir) {
    settings.update({ modelsDir: move(s.modelsDir), meetings: { ...s.meetings, dir: move(s.meetings.dir) } });
  }
}
