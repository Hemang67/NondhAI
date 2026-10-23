import { dialog, shell } from "electron";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { ClipRecord, MeetingRecord } from "@shared/types";
import type { LibraryMeeting, VideoProgress, VideoProjectDetail } from "@shared/ipc";
import { clipRef, duration, emptySpec, subtitlesFromTranscript, toSrt, type BlurBox, type ProjectSpec, type VideoProject } from "@shared/video/project";
import { buildRender, parseProgress } from "@shared/video/render";
import { intoCrop, suggestBlurs, type OcrFrame } from "@shared/video/sensitive";
import type { ClipRepo, MeetingRepo } from "../storage/meetings";
import type { VideoProjectRepo } from "../storage/videoProjects";
import { encryptFile, ffmpegPath, readAudio } from "../meeting/audioFiles";
import { resourcePath } from "../windows";
import { log } from "../log";

const FONT = "C:/Windows/Fonts/segoeui.ttf";
const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "ogg", "opus", "flac", "wma"];

const clipLen = (c: ClipRecord) => Math.max(0, ((c.endMs ?? c.startMs) - c.startMs) / 1000);
const usable = (c: ClipRecord) => !!c.file && c.endMs !== null && clipLen(c) > 0.2;

/**
 * The video library: edits made from a meeting's screen clips (one clip, or several merged),
 * rendered with FFmpeg into an MP4 kept with the meeting.
 */
export class VideoService extends EventEmitter {
  private jobs = new Map<string, ChildProcess>();
  private cancelled = new Set<string>();

  constructor(
    private readonly d: {
      videos: VideoProjectRepo;
      clips: ClipRepo;
      meetings: MeetingRepo;
      encrypt: () => boolean;
    },
  ) {
    super();
    // Working folders of an export or scan cut short by a quit or crash (they can hold decrypted
    // copies of recordings).
    for (const name of readdirSync(tmpdir())) {
      if (/^nondh-(edit|ocr)-/.test(name)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
    }
    // An export cut short by a quit or crash left a partial file behind.
    for (const p of d.videos.interrupted()) {
      const m = d.meetings.get(p.meetingId);
      if (m) rmSync(join(m.dir, `edit-${p.id}.part.mp4`), { force: true });
      d.videos.setExport(p.id, { status: "error", error: "The export was interrupted. Export again." });
    }
  }

  library(): { meetings: LibraryMeeting[]; projects: VideoProject[] } {
    const meetings: LibraryMeeting[] = [];
    for (const m of this.d.meetings.list({ limit: 100000 })) {
      const clips = this.d.clips.forMeeting(m.id).filter(usable);
      if (clips.length) meetings.push({ id: m.id, title: m.title, startedAt: m.startedAt, clips });
    }
    return { meetings, projects: this.d.videos.list() };
  }

  private meeting(id: string): MeetingRecord {
    const m = this.d.meetings.get(id);
    if (!m) throw new Error("That meeting no longer exists");
    return m;
  }

  private speakerNames(meetingId: string): Record<string, string> {
    return Object.fromEntries(this.d.meetings.speakers(meetingId).map((s) => [s.key, s.name]));
  }

  /** A new edit of one clip, or several clips of the same meeting merged in time order. */
  create(meetingId: string, clipIds: string[], title?: string): VideoProject {
    const m = this.meeting(meetingId);
    const clips = clipIds
      .map((id) => this.d.clips.get(id))
      .filter((c): c is ClipRecord => !!c && c.meetingId === m.id && usable(c))
      .sort((a, b) => a.startMs - b.startMs);
    if (!clips.length || clips.length !== new Set(clipIds).size) throw new Error("Only finished screen recordings from the same meeting can be combined");
    const refs = clips.map(clipRef);
    const spec = emptySpec(refs);
    const names = this.speakerNames(m.id);
    spec.subtitles.lines = subtitlesFromTranscript(spec, refs, this.d.meetings.lines(m.id), (k) => names[k] ?? k);
    const name = title?.trim() || (clips.length > 1 ? `${m.title} — ${clips.length} clips merged` : `${m.title} — ${clips[0]!.label}`);
    return this.d.videos.create({ meetingId: m.id, title: name, spec });
  }

  get(id: string): VideoProjectDetail | null {
    const project = this.d.videos.get(id);
    if (!project) return null;
    const m = this.d.meetings.get(project.meetingId);
    if (!m) return null;
    return {
      project,
      meeting: { id: m.id, title: m.title, hasAudio: !!m.audioFile },
      clips: this.d.clips.forMeeting(m.id).filter(usable),
      lines: this.d.meetings.lines(m.id),
      speakers: this.speakerNames(m.id),
    };
  }

  save(id: string, patch: { title?: string; spec?: ProjectSpec }): VideoProject | null {
    return this.d.videos.update(id, patch);
  }

  /** Subtitles rebuilt from the (possibly edited) transcript for the current timeline. */
  subtitlesFor(id: string, spec: ProjectSpec): ProjectSpec["subtitles"]["lines"] {
    const p = this.d.videos.get(id);
    if (!p) return [];
    const refs = this.d.clips.forMeeting(p.meetingId).filter(usable).map(clipRef);
    const names = this.speakerNames(p.meetingId);
    return subtitlesFromTranscript(spec, refs, this.d.meetings.lines(p.meetingId), (k) => names[k] ?? k);
  }

  delete(id: string): void {
    const p = this.d.videos.get(id);
    if (!p) return;
    this.cancel(id);
    const m = this.d.meetings.get(p.meetingId);
    if (m) {
      if (p.exportFile) rmSync(join(m.dir, p.exportFile), { force: true });
      // Added images and audio that no other edit of this meeting uses.
      const others = this.d.videos.forMeeting(m.id).filter((o) => o.id !== id);
      const inUse = new Set(others.flatMap((o) => [...o.spec.images.map((i) => i.file), ...o.spec.audioTracks.map((a) => a.file)]));
      for (const f of [...p.spec.images.map((i) => i.file), ...p.spec.audioTracks.map((a) => a.file)]) {
        if (!inUse.has(f) && f.startsWith(join(m.dir, "video-assets"))) rmSync(f, { force: true });
      }
    }
    this.d.videos.delete(id);
  }

  /** Removes every export of a meeting (used when its recordings are deleted). */
  deleteExports(m: MeetingRecord): void {
    for (const p of this.d.videos.forMeeting(m.id)) {
      if (p.exportFile) rmSync(join(m.dir, p.exportFile), { force: true });
      this.d.videos.setExport(p.id, { status: "none", file: null });
    }
  }

  /** Copies a picked image or audio file next to the meeting, so the edit keeps working if the original moves. */
  async pickAsset(id: string, kind: "image" | "audio"): Promise<{ file: string; name: string } | null> {
    const p = this.d.videos.get(id);
    if (!p) return null;
    const m = this.meeting(p.meetingId);
    const r = await dialog.showOpenDialog({
      title: kind === "image" ? "Add an image" : "Add audio",
      properties: ["openFile"],
      filters: [kind === "image" ? { name: "Images", extensions: IMAGE_EXT } : { name: "Audio", extensions: AUDIO_EXT }],
    });
    const src = r.filePaths[0];
    if (r.canceled || !src) return null;
    const dir = join(m.dir, "video-assets");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${randomUUID()}${extname(src).toLowerCase()}`);
    copyFileSync(src, file);
    return { file, name: basename(src) };
  }

  /** Readable copies of encrypted inputs, in a private temp folder the caller removes. */
  private plainInputs(m: MeetingRecord, clips: ClipRecord[], tmp: string) {
    const files: Record<string, { file: string; width: number; height: number; startMs: number }> = {};
    for (const c of clips) {
      let file = join(m.dir, c.file!);
      if (c.encrypted || file.endsWith(".enc")) {
        const out = join(tmp, `${c.id}.webm`);
        writeFileSync(out, readAudio(file));
        file = out;
      }
      files[c.id] = { file, width: c.width ?? 1280, height: c.height ?? 720, startMs: c.startMs };
    }
    let audio: string | null = null;
    if (m.audioFile) {
      audio = join(m.dir, m.audioFile);
      if (audio.endsWith(".enc")) {
        const out = join(tmp, "audio.opus");
        writeFileSync(out, readAudio(audio));
        audio = out;
      }
    }
    return { files, audio };
  }

  private progress(id: string, p: VideoProgress): void {
    this.emit("progress", id, p);
  }

  private ffmpeg(id: string, args: string[], onOut?: (s: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath(), args, { windowsHide: true });
      this.jobs.set(id, child);
      let err = "";
      child.stdout.on("data", (b: Buffer) => onOut?.(b.toString()));
      child.stderr.on("data", (b: Buffer) => (err = (err + b.toString()).slice(-4000)));
      child.on("error", reject);
      child.on("close", (code) => {
        this.jobs.delete(id);
        if (this.cancelled.delete(id)) reject(new Error("cancelled"));
        else if (code === 0) resolve();
        else reject(new Error(err.trim().split(/\r?\n/).pop() || `ffmpeg exited with ${code}`));
      });
    });
  }

  cancel(id: string): void {
    const j = this.jobs.get(id);
    if (!j) return;
    this.cancelled.add(id);
    j.kill();
  }

  /** Renders the edit to <meeting>/edit-<id>.mp4 (encrypted like the recordings when that is on). */
  async export(id: string): Promise<void> {
    if (this.jobs.has(id)) return;
    const p = this.d.videos.get(id);
    if (!p) throw new Error("That edit no longer exists");
    const m = this.meeting(p.meetingId);
    const clips = this.d.clips.forMeeting(m.id).filter(usable);
    const used = new Set(p.spec.segments.map((s) => s.clipId));
    if ([...used].some((cid) => !clips.find((c) => c.id === cid))) throw new Error("A screen recording used in this edit was deleted");
    for (const f of [...p.spec.images.map((i) => i.file), ...p.spec.audioTracks.map((a) => a.file)]) {
      if (!existsSync(f)) throw new Error(`An added file is missing: ${basename(f)}`);
    }

    const tmp = mkdtempSync(join(tmpdir(), "nondh-edit-"));
    const part = join(m.dir, `edit-${id}.part.mp4`);
    this.d.videos.setExport(id, { status: "rendering" });
    this.progress(id, { phase: "preparing", fraction: 0 });
    try {
      const inputs = this.plainInputs(m, clips.filter((c) => used.has(c.id)), tmp);
      const plan = buildRender({
        spec: p.spec,
        clips: inputs.files,
        meetingAudio: inputs.audio,
        font: FONT,
        tmpDir: tmp.replace(/\\/g, "/"),
        output: part,
      });
      for (const f of plan.files) writeFileSync(f.path, f.content, "utf8");
      // Everything up to the spawn is synchronous, so a second click can't start a second job.
      await this.ffmpeg(id, plan.args, (s) => {
        const t = parseProgress(s);
        if (t !== null) this.progress(id, { phase: "rendering", fraction: Math.min(0.99, t / plan.duration) });
      });
      let final = join(m.dir, `edit-${id}.mp4`);
      rmSync(final, { force: true });
      rmSync(`${final}.enc`, { force: true });
      renameSync(part, final);
      if (this.d.encrypt()) final = encryptFile(final);
      this.d.videos.setExport(id, { status: "done", file: basename(final) });
      this.progress(id, { phase: "done", fraction: 1 });
      log.info("video exported", { id, seconds: plan.duration, size: `${plan.width}x${plan.height}` });
    } catch (err) {
      rmSync(part, { force: true });
      const msg = (err as Error).message;
      if (msg === "cancelled") {
        this.d.videos.setExport(id, { status: p.exportFile ? "done" : "none" });
        this.progress(id, { phase: "cancelled", fraction: 0 });
      } else {
        log.error("video export failed", err);
        this.d.videos.setExport(id, { status: "error", error: msg });
        this.progress(id, { phase: "error", fraction: 0, error: msg });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Saves a plain copy of the export (and an .srt beside it when asked for). */
  async saveCopy(id: string): Promise<string | null> {
    const p = this.d.videos.get(id);
    if (!p?.exportFile) return null;
    const m = this.meeting(p.meetingId);
    const safe = p.title.replace(/[<>:"/\\|?*]+/g, " ").trim() || "Nondh AI video";
    const r = await dialog.showSaveDialog({ defaultPath: `${safe}.mp4`, filters: [{ name: "MP4 video", extensions: ["mp4"] }] });
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, readAudio(join(m.dir, p.exportFile)));
    if (p.spec.subtitles.exportSrt && p.spec.subtitles.lines.length) {
      writeFileSync(r.filePath.replace(/\.mp4$/i, "") + ".srt", toSrt(p.spec.subtitles.lines), "utf8");
    }
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  }

  /**
   * "Find sensitive info": samples the edited timeline, reads text with Windows OCR and suggests
   * blur boxes over passwords, keys, tokens and card numbers. Nothing leaves the computer.
   */
  async findSensitive(id: string, spec: ProjectSpec): Promise<BlurBox[]> {
    if (this.jobs.has(id)) throw new Error("Busy with this edit, try again when it finishes");
    const p = this.d.videos.get(id);
    if (!p) throw new Error("That edit no longer exists");
    const m = this.meeting(p.meetingId);
    const clips = this.d.clips.forMeeting(m.id).filter(usable);
    const total = duration(spec);
    // About one frame a second; long edits are sampled more sparsely (at most ~600 frames).
    const interval = Math.max(1, Math.ceil(total / 600));
    const tmp = mkdtempSync(join(tmpdir(), "nondh-ocr-"));
    this.progress(id, { phase: "scanning", fraction: 0 });
    try {
      const used = new Set(spec.segments.map((s) => s.clipId));
      const inputs = this.plainInputs(m, clips.filter((c) => used.has(c.id)), tmp);
      const first = inputs.files[spec.segments[0]!.clipId];
      if (!first) throw new Error("A screen recording used in this edit was deleted");
      const W = first.width - (first.width % 2);
      const H = first.height - (first.height % 2);
      const frameTimes = new Map<string, number>();
      let t0 = 0;
      for (const [k, s] of spec.segments.entries()) {
        const c = inputs.files[s.clipId];
        if (!c) throw new Error("A screen recording used in this edit was deleted");
        const len = s.out - s.in;
        const prefix = `s${String(k).padStart(3, "0")}_`;
        // Same scale/pad as the export, so boxes line up with the exported frame.
        await this.ffmpeg(id, [
          "-y", "-hide_banner", "-loglevel", "error",
          "-ss", String(s.in), "-t", String(len), "-i", c.file,
          "-vf", `fps=1/${interval},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
          join(tmp, `${prefix}%05d.png`),
        ]);
        for (const f of readdirSync(tmp).filter((f) => f.startsWith(prefix)).sort()) {
          const n = Number(f.slice(prefix.length, -4)) - 1;
          frameTimes.set(f, t0 + n * interval);
        }
        t0 += len;
        this.progress(id, { phase: "scanning", fraction: 0.15 * ((k + 1) / spec.segments.length) });
      }
      const frames = await this.ocr(id, tmp, frameTimes.size, (done) =>
        this.progress(id, { phase: "scanning", fraction: 0.15 + 0.85 * (done / Math.max(1, frameTimes.size)) }),
      );
      const timed: OcrFrame[] = frames.flatMap((f) => (frameTimes.has(f.frame) ? [{ ...f, time: frameTimes.get(f.frame)! }] : []));
      const boxes = suggestBlurs(timed, interval)
        .map((b) => ({ ...b, rect: intoCrop(b.rect, spec.crop), end: Math.min(total, b.end) }))
        .filter((b): b is BlurBox => !!b.rect);
      this.progress(id, { phase: "done", fraction: 1 });
      log.info("sensitive scan", { frames: timed.length, suggestions: boxes.length });
      return boxes;
    } catch (err) {
      const msg = (err as Error).message;
      this.progress(id, { phase: msg === "cancelled" ? "cancelled" : "error", fraction: 0, error: msg });
      throw err;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  private ocr(id: string, dir: string, count: number, onFrame: (done: number) => void): Promise<Array<OcrFrame & { frame: string }>> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resourcePath("ocr.ps1"), "-dir", dir],
        { windowsHide: true },
      );
      this.jobs.set(id, child);
      const out: Array<OcrFrame & { frame: string }> = [];
      let buf = "";
      let err = "";
      child.stdout.on("data", (b: Buffer) => {
        buf += b.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("{")) continue;
          try {
            const f = JSON.parse(line) as { frame: string; width: number; height: number; lines: OcrFrame["lines"] | null };
            out.push({ frame: f.frame, time: 0, width: f.width, height: f.height, lines: (f.lines ?? []).map((l) => ({ words: l.words ?? [] })) });
            onFrame(Math.min(count, out.length));
          } catch {
            /* a partial line; ignore */
          }
        }
      });
      child.stderr.on("data", (b: Buffer) => (err = (err + b.toString()).slice(-2000)));
      child.on("error", reject);
      child.on("close", (code) => {
        this.jobs.delete(id);
        if (this.cancelled.delete(id)) reject(new Error("cancelled"));
        else if (code === 0) resolve(out);
        else reject(new Error(err.trim().split(/\r?\n/)[0] || `Text recognition failed (${code})`));
      });
    });
  }
}
