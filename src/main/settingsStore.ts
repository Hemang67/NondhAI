import { EventEmitter } from "node:events";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "@shared/settings";
import { userDataPath } from "./paths";

export class SettingsStore extends EventEmitter {
  private current: Settings;
  private readonly file = userDataPath("settings.json");

  constructor() {
    super();
    let saved: unknown = {};
    if (existsSync(this.file)) {
      try {
        saved = JSON.parse(readFileSync(this.file, "utf8"));
      } catch (err) {
        console.error("settings.json is unreadable, using defaults", err);
      }
    }
    this.current = mergeSettings(saved);
  }

  get(): Settings {
    return this.current;
  }

  /** Apply a deep partial update and persist atomically. */
  update(patch: unknown): Settings {
    const prev = this.current;
    this.current = mergeSettings(patch, prev);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.current, null, 2));
    renameSync(tmp, this.file);
    this.emit("change", this.current, prev);
    return this.current;
  }

  reset(): Settings {
    return this.update(DEFAULT_SETTINGS);
  }
}
