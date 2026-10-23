import { app } from "electron";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { ProjectSpec } from "@shared/video/project";
import { legacyRoots, swapRoot } from "@shared/legacyPaths";
import type { SettingsStore } from "./settingsStore";
import { log } from "./log";

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

type Move = { from: string; to: string };

/**
 * Folders the user picked for models and recordings that are named after the old app name
 * ("D:\Nondh AI-data") are renamed in place to the new name ("D:\Nondh AI-data"), and the
 * settings follow. Runs before anything opens those folders. Returns the moves made (or found
 * already made), for the stored paths that also need updating.
 */
export function renameLegacyFolders(settings: SettingsStore): Move[] {
  const s = settings.get();
  const done: Move[] = [];
  for (const m of legacyRoots([s.modelsDir, s.meetings.dir])) {
    if (existsSync(m.from) && !existsSync(m.to)) {
      try {
        renameSync(m.from, m.to);
        log.info("renamed data folder", m);
      } catch (err) {
        log.error(`couldn't rename ${m.from}; still using it`, err);
        continue;
      }
    }
    if (existsSync(m.to) && !existsSync(m.from)) done.push(m);
  }
  if (done.length) {
    const swap = (p: string) => done.reduce((acc, m) => swapRoot(acc, m.from, m.to), p);
    settings.update({ modelsDir: swap(s.modelsDir), meetings: { ...s.meetings, dir: swap(s.meetings.dir) } });
  }
  return done;
}

/**
 * Points stored paths that still lead into an old folder at its new place: meeting folders, and
 * images and music added to video edits. Safe to run on every start.
 */
export function fixLegacyPaths(db: Database.Database, settings: SettingsStore, moved: Move[]): void {
  const moves: Move[] = [...moved];
  const dest = app.getPath("userData");
  if (dest.toLowerCase() !== LEGACY_DATA_DIR.toLowerCase()) moves.push({ from: LEGACY_DATA_DIR, to: dest });
  const swap = (p: string) => moves.reduce((acc, m) => swapRoot(acc, m.from, m.to), p);

  db.transaction(() => {
    const update = db.prepare(`UPDATE meetings SET dir = ? WHERE id = ?`);
    for (const r of db.prepare(`SELECT id, dir FROM meetings`).all() as Array<{ id: string; dir: string }>) {
      const next = swap(r.dir);
      if (next !== r.dir) update.run(next, r.id);
    }
    const save = db.prepare(`UPDATE video_projects SET spec_json = ? WHERE id = ?`);
    for (const r of db.prepare(`SELECT id, spec_json FROM video_projects`).all() as Array<{ id: string; spec_json: string }>) {
      const spec = JSON.parse(r.spec_json) as ProjectSpec;
      const images = spec.images.map((i) => ({ ...i, file: swap(i.file) }));
      const audioTracks = spec.audioTracks.map((a) => ({ ...a, file: swap(a.file) }));
      const changed = images.some((i, k) => i.file !== spec.images[k]!.file) || audioTracks.some((a, k) => a.file !== spec.audioTracks[k]!.file);
      if (changed) save.run(JSON.stringify({ ...spec, images, audioTracks }), r.id);
    }
  })();

  const s = settings.get();
  if (swap(s.modelsDir) !== s.modelsDir || swap(s.meetings.dir) !== s.meetings.dir) {
    settings.update({ modelsDir: swap(s.modelsDir), meetings: { ...s.meetings, dir: swap(s.meetings.dir) } });
  }
}
