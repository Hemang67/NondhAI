import { app, Notification } from "electron";
import { autoUpdater } from "electron-updater";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { log } from "./log";

export type UpdateStatus = { state: "off" | "idle" | "checking" | "available" | "downloading" | "ready" | "none" | "error"; version?: string; error?: string };

/**
 * Updates from a "generic" feed: a web URL or a local/network folder containing the
 * electron-builder output (latest.yml + Nondh AI-Setup-x.y.z.exe). The installer is unsigned,
 * so no publisher check is configured.
 */
export class Updater {
  status: UpdateStatus = { state: "off" };
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly onChange: (s: UpdateStatus) => void) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = { info: (m: unknown) => log.info("[update]", m), warn: (m: unknown) => log.warn("[update]", m), error: (m: unknown) => log.error("[update]", m), debug: () => {} } as never;
    autoUpdater.on("checking-for-update", () => this.set({ state: "checking" }));
    autoUpdater.on("update-not-available", () => this.set({ state: "none" }));
    autoUpdater.on("update-available", (i) => this.set({ state: "downloading", version: i.version }));
    autoUpdater.on("update-downloaded", (i) => {
      this.set({ state: "ready", version: i.version });
      new Notification({ title: "Nondh AI update ready", body: `Version ${i.version} installs when you restart Nondh AI.` }).show();
    });
    autoUpdater.on("error", (e) => this.set({ state: "error", error: e.message }));
  }

  private set(s: UpdateStatus): void {
    this.status = s;
    this.onChange(s);
  }

  configure(feed: string): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!feed.trim() || !app.isPackaged) {
      this.set({ state: "off" });
      return;
    }
    // A plain folder path becomes a file:// feed.
    const url = /^[a-z]+:\/\//i.test(feed) ? feed : existsSync(feed) ? pathToFileURL(feed).href : feed;
    autoUpdater.setFeedURL({ provider: "generic", url });
    this.set({ state: "idle" });
    void this.check();
    this.timer = setInterval(() => void this.check(), 6 * 3600 * 1000);
  }

  async check(): Promise<void> {
    if (this.status.state === "off") return;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.set({ state: "error", error: (e as Error).message });
    }
  }

  installNow(): void {
    if (this.status.state === "ready") autoUpdater.quitAndInstall(false, true);
  }
}
