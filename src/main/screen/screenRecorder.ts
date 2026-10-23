import { BrowserWindow, desktopCapturer, ipcMain, screen } from "electron";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Rect } from "@shared/screen";
import type { ScreenSource, ScreenState } from "@shared/ipc";
import type { ClipKind, ClipRecord } from "@shared/types";
import type { ClipRepo, MeetingRepo } from "../storage/meetings";
import { encryptFile, ffmpegPath } from "../meeting/audioFiles";
import { createRegionWindow, createScreenRecorderWindow } from "../windows";
import { log } from "../log";
import { APP_NAME } from "@shared/brand";

const run = promisify(execFile);

interface Active extends ScreenState {
  fd: number;
  path: string;
  startMs: number;
  writes: Promise<void>;
}

/**
 * Screen recordings during a meeting, started and stopped by the user as often as they like.
 * Capture runs in a hidden renderer (MediaRecorder, VP8 WebM); chunks are appended to disk as
 * they arrive so a crash keeps everything recorded so far.
 */
export class ScreenRecorder extends EventEmitter {
  private recorder: BrowserWindow | null = null;
  private recorderReady: Promise<BrowserWindow> | null = null;
  private active: Active | null = null;
  private stopping: Active | null = null;
  private waiters = new Map<string, (r: { error?: string | null; width?: number; height?: number }) => void>();

  constructor(
    private readonly d: {
      clips: ClipRepo;
      meetings: MeetingRepo;
      recording: () => { id: string; startedAt: number } | null;
      encrypt: () => boolean;
    },
  ) {
    super();
    ipcMain.on("screen:chunk", (_e, clipId: string, data: ArrayBuffer) => {
      // The final chunk arrives after Stop was pressed, while the clip is being closed.
      const a = this.active?.clipId === clipId ? this.active : this.stopping;
      if (!a || a.clipId !== clipId) return;
      a.writes = a.writes.then(() => {
        writeSync(a.fd, Buffer.from(data));
      });
    });
    ipcMain.on("screen:started", (_e, clipId: string, error: string | null, width: number, height: number) =>
      this.waiters.get(`start:${clipId}`)?.({ error, width, height }),
    );
    ipcMain.on("screen:ended", (_e, clipId: string, width: number, height: number) => {
      const w = this.waiters.get(`end:${clipId}`);
      if (w) w({ width, height });
      // The captured window closed or the display went away: finish the clip.
      else if (this.active?.clipId === clipId) void this.stop();
    });
  }

  get state(): ScreenState | null {
    if (!this.active) return null;
    const { clipId, meetingId, kind, label, startedAt } = this.active;
    return { clipId, meetingId, kind, label, startedAt };
  }

  private ensureRecorder(): Promise<BrowserWindow> {
    if (this.recorder && !this.recorder.isDestroyed() && this.recorderReady) return this.recorderReady;
    const w = createScreenRecorderWindow();
    this.recorder = w;
    this.recorderReady = new Promise((resolve) => w.webContents.once("did-finish-load", () => resolve(w)));
    return this.recorderReady;
  }

  async sources(): Promise<ScreenSource[]> {
    const all = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    return all
      .filter((s) => !s.name.startsWith(APP_NAME)) // never offer the app's own windows
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith("screen:") ? ("screen" as const) : ("window" as const),
        thumbnail: s.thumbnail.toDataURL(),
        displayId: s.display_id || null,
      }));
  }

  /** Let the user drag a rectangle on one display. Resolves null if they press Esc. */
  pickRegion(displayId: string | null): Promise<{ rect: Rect; displayId: string } | null> {
    const display = screen.getAllDisplays().find((d) => String(d.id) === displayId) ?? screen.getPrimaryDisplay();
    const win = createRegionWindow(display);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { rect: Rect; displayId: string } | null) => {
        if (settled) return;
        settled = true;
        ipcMain.removeHandler("region:done");
        resolve(value);
        // Close after replying to the overlay's call, so its invoke settles cleanly.
        setTimeout(() => !win.isDestroyed() && win.destroy(), 50);
      };
      ipcMain.removeHandler("region:done");
      ipcMain.handle("region:done", (_e, rect: Rect | null) =>
        finish(rect && rect.width >= 8 && rect.height >= 8 ? { rect, displayId: String(display.id) } : null),
      );
      win.on("closed", () => finish(null)); // closed some other way = cancelled
    });
  }

  async start(opts: { sourceId: string; kind: ClipKind; label: string; region?: Rect; displayId?: string | null }): Promise<ClipRecord> {
    const meeting = this.d.recording();
    if (!meeting) throw new Error("Screen recording is only available while a meeting is being recorded");
    if (this.active) await this.stop();
    const m = this.d.meetings.get(meeting.id);
    if (!m) throw new Error("meeting not found");
    const n = this.d.clips.forMeeting(m.id).length + 1;
    const file = `screen-${n}.webm`;
    const path = join(m.dir, file);
    const startMs = Date.now() - meeting.startedAt;
    const clip = this.d.clips.create({ meetingId: m.id, kind: opts.kind, label: opts.label, startMs, file });
    const fd = openSync(path, "w");
    this.active = { clipId: clip.id, meetingId: m.id, kind: opts.kind, label: opts.label, startedAt: Date.now(), fd, path, startMs, writes: Promise.resolve() };

    const display = opts.region ? (screen.getAllDisplays().find((d) => String(d.id) === opts.displayId) ?? screen.getPrimaryDisplay()) : null;
    const w = await this.ensureRecorder();
    const started = new Promise<{ error?: string | null; width?: number; height?: number }>((resolve) => {
      this.waiters.set(`start:${clip.id}`, resolve);
      setTimeout(() => resolve({ error: "screen capture did not start" }), 10000);
    });
    w.webContents.send("screen:begin", {
      clipId: clip.id,
      sourceId: opts.sourceId,
      region: opts.region ?? null,
      display: display ? { width: display.size.width, height: display.size.height } : null,
    });
    const r = await started;
    this.waiters.delete(`start:${clip.id}`);
    if (r.error) {
      closeSync(fd);
      rmSync(path, { force: true });
      this.d.clips.delete(clip.id);
      this.active = null;
      throw new Error(r.error);
    }
    // Time the clip from the moment capture really began, so it lines up with the meeting audio.
    if (this.active?.clipId === clip.id) {
      this.active.startedAt = Date.now();
      this.active.startMs = Date.now() - meeting.startedAt;
      this.d.clips.setStart(clip.id, this.active.startMs);
    }
    log.info(`screen clip ${n} started (${opts.kind}: ${opts.label}) ${r.width}x${r.height} in meeting ${m.id}`);
    this.emit("state", this.state);
    return this.d.clips.get(clip.id)!;
  }

  async stop(): Promise<void> {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.stopping = a;
    const ended = new Promise<{ width?: number; height?: number }>((resolve) => {
      this.waiters.set(`end:${a.clipId}`, resolve);
      setTimeout(() => resolve({}), 5000);
    });
    this.recorder?.webContents.send("screen:end", a.clipId);
    const size = await ended;
    this.waiters.delete(`end:${a.clipId}`);
    await a.writes;
    if (this.stopping === a) this.stopping = null;
    fsyncSync(a.fd);
    closeSync(a.fd);
    const endMs = a.startMs + (Date.now() - a.startedAt);
    const file = await this.finalize(a.path).catch((err) => {
      log.error("screen clip finalize failed", err);
      return existsSync(a.path) ? a.path : null;
    });
    this.d.clips.finish(a.clipId, {
      endMs,
      file: file ? file.split(/[\\/]/).pop()! : null,
      width: size.width ?? null,
      height: size.height ?? null,
      encrypted: !!file?.endsWith(".enc"),
    });
    log.info(`screen clip stopped after ${Math.round((endMs - a.startMs) / 1000)} s`);
    this.emit("state", null);
    this.emit("changed", a.meetingId);
  }

  /**
   * MediaRecorder writes WebM without a duration or seek index; a copy remux adds both so the
   * clip can be scrubbed. Encrypts afterwards when encryption is on.
   */
  private async finalize(path: string): Promise<string> {
    if (!existsSync(path) || statSync(path).size === 0) {
      rmSync(path, { force: true });
      throw new Error("empty screen clip");
    }
    const tmp = `${path}.fixed.webm`;
    await run(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-i", path, "-c", "copy", tmp], { windowsHide: true });
    renameSync(tmp, path);
    return this.d.encrypt() ? encryptFile(path) : path;
  }

  /** Clips left open by a crash: keep what was written. */
  async recover(): Promise<void> {
    for (const c of this.d.clips.unfinished()) {
      if (this.active?.clipId === c.id) continue;
      const m = this.d.meetings.get(c.meetingId);
      const path = m && c.file ? join(m.dir, c.file) : null;
      let file: string | null = null;
      if (path && existsSync(path)) file = await this.finalize(path).catch(() => null);
      this.d.clips.finish(c.id, { endMs: c.startMs, file: file ? file.split(/[\\/]/).pop()! : null });
      log.info(`recovered screen clip ${c.id} (${file ? "kept" : "no data"})`);
    }
  }

  deleteClip(clip: ClipRecord, dir: string): void {
    if (clip.file) rmSync(join(dir, clip.file), { force: true });
    this.d.clips.delete(clip.id);
  }
}
