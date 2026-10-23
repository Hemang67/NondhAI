import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { classifyMicUser, parseMicUsage } from "@shared/meeting/detect";
import { log } from "../log";
import { binPath } from "../paths";

const run = promisify(execFile);
const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

/** Executables with an active microphone stream right now (vd-audio --sessions). */
async function activeCaptureProcesses(): Promise<string[]> {
  try {
    const { stdout } = await run(binPath("vd-audio.exe"), ["--sessions"], { windowsHide: true, timeout: 5000 });
    const paths = stdout.split(/\r?\n/).map((l) => l.split("\t")[1]?.trim() ?? "");
    return [...new Set(paths.filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * Titles of browser windows (vd-audio --windows reads cached captions, so a frozen window can't
 * block it; `tasklist /v` was seen hanging for minutes on a real machine).
 */
async function browserTitles(): Promise<string[]> {
  try {
    const { stdout } = await run(binPath("vd-audio.exe"), ["--windows"], { windowsHide: true, timeout: 5000, maxBuffer: 4 << 20 });
    return stdout
      .split(/\r?\n/)
      .map((l) => l.split("\t"))
      .filter(([exe]) => /(chrome|msedge|firefox|brave|opera|vivaldi|arc)\.exe$/i.test(exe ?? ""))
      .map(([, title]) => title?.trim() ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Polls microphone usage every few seconds and emits:
 *  - "started" (app) when a meeting app (or, with anyApp, any app) begins using the mic,
 *  - "ended" (app) when it stops (after a grace period, so brief mutes don't count).
 */
export class MeetingDetector extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private active = new Map<string, { app: string; lastSeen: number }>();

  constructor(
    private readonly selfExe: string,
    /** anyApp: prompt for any app using the mic, not only known meeting apps. */
    private readonly opts: () => { anyApp: boolean; ignorePaths: string[] },
  ) {
    super();
  }

  start(intervalMs = 3000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.active.clear();
  }

  private polling = false;

  private async poll(): Promise<void> {
    // Never let slow polls pile up.
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } catch (err) {
      log.warn("meeting detection poll failed", err);
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    // Two sources: Windows' privacy registry (good for Store apps such as new Teams) and the audio
    // engine's live capture sessions (catches every app, including ones the registry misses).
    let out = "";
    try {
      out = (await run("reg", ["query", KEY, "/s"], { windowsHide: true, timeout: 5000, maxBuffer: 4 << 20 })).stdout;
    } catch (err) {
      log.warn("mic usage query failed", err);
    }
    const users = parseMicUsage(out).filter((u) => u.inUse);
    for (const path of await activeCaptureProcesses()) {
      const known = users.some((u) => u.key.replace(/#/g, "\\").toLowerCase() === path.toLowerCase());
      if (!known) users.push({ key: path, inUse: true });
    }
    const opts = this.opts();
    const needTitles = users.some((u) => /(chrome|msedge|firefox|brave|opera|vivaldi|arc)\.exe$/i.test(u.key));
    const titles = needTitles ? await browserTitles() : [];
    const now = Date.now();
    const seen = new Set<string>();
    for (const u of users) {
      const app = classifyMicUser(u.key, titles, this.selfExe, opts);
      if (!app) continue;
      const id = u.key.replace(/#/g, "\\").toLowerCase();
      seen.add(id);
      if (!this.active.has(id)) {
        this.active.set(id, { app, lastSeen: now });
        log.info(`meeting detected: ${app}`);
        this.emit("started", app);
      } else this.active.get(id)!.lastSeen = now;
    }
    for (const [id, a] of this.active) {
      if (!seen.has(id) && now - a.lastSeen > 15000) {
        this.active.delete(id);
        log.info(`meeting ended: ${a.app}`);
        this.emit("ended", a.app);
      }
    }
  }
}
