import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { classifyMicUser, parseMicUsage } from "@shared/meeting/detect";
import { log } from "../log";

const run = promisify(execFile);
const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

async function browserTitles(): Promise<string[]> {
  try {
    const { stdout } = await run("tasklist", ["/v", "/fo", "csv", "/nh"], { windowsHide: true, maxBuffer: 8 << 20 });
    return stdout
      .split(/\r?\n/)
      .filter((l) => /^"(chrome|msedge|firefox|brave|opera|vivaldi|arc)\.exe"/i.test(l))
      .map((l) => l.split('","').pop()?.replace(/"$/, "") ?? "")
      .filter((t) => t && t !== "N/A");
  } catch {
    return [];
  }
}

/**
 * Polls Windows' microphone usage every few seconds and emits:
 *  - "started" (app) when a meeting app begins using the mic,
 *  - "ended" (app) when it stops (after a grace period, so brief mutes don't count).
 */
export class MeetingDetector extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private active = new Map<string, { app: string; lastSeen: number }>();

  constructor(private readonly selfExe: string) {
    super();
  }

  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.active.clear();
  }

  private async poll(): Promise<void> {
    let out: string;
    try {
      out = (await run("reg", ["query", KEY, "/s"], { windowsHide: true, maxBuffer: 4 << 20 })).stdout;
    } catch (err) {
      log.warn("mic usage query failed", err);
      return;
    }
    const users = parseMicUsage(out).filter((u) => u.inUse);
    const needTitles = users.some((u) => /(chrome|msedge|firefox|brave|opera|vivaldi|arc)\.exe$/i.test(u.key));
    const titles = needTitles ? await browserTitles() : [];
    const now = Date.now();
    const seen = new Set<string>();
    for (const u of users) {
      const app = classifyMicUser(u.key, titles, this.selfExe);
      if (!app) continue;
      seen.add(u.key);
      if (!this.active.has(u.key)) {
        this.active.set(u.key, { app, lastSeen: now });
        log.info(`meeting detected: ${app}`);
        this.emit("started", app);
      } else this.active.get(u.key)!.lastSeen = now;
    }
    for (const [key, a] of this.active) {
      if (!seen.has(key) && now - a.lastSeen > 15000) {
        this.active.delete(key);
        log.info(`meeting ended: ${a.app}`);
        this.emit("ended", a.app);
      }
    }
  }
}
