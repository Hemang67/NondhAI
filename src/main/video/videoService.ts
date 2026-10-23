import { dialog, shell } from "electron";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { ClipRecord, MeetingRecord } from "@shared/types";
import type { Segment, TranscriptLine } from "@shared/meeting/types";
import type { LibraryMeeting, VideoProgress, VideoProjectDetail } from "@shared/ipc";
import {
  clipRef,
  duration,
  emptySpec,
  LIBRARY,
  segLen,
  segmentStarts,
  speechToSubtitles,
  subtitlesFromTranscript,
  toSrt,
  type BlurBox,
  type LibraryVideo,
  type ProjectSpec,
  type SubtitleLine,
  type VideoProject,
} from "@shared/video/project";
import { buildRender, parseProgress } from "@shared/video/render";
import { displaySize, importMode, parseProbe } from "@shared/video/probe";
import { hiddenText, intoCrop, suggestBlurs, type OcrFrame } from "@shared/video/sensitive";
import type { ClipRepo, MeetingRepo } from "../storage/meetings";
import type { LibraryVideoRepo, VideoProjectRepo } from "../storage/videoProjects";
import { encryptFile, ffmpegPath, readAudio } from "../meeting/audioFiles";
import { resourcePath } from "../windows";
import { log } from "../log";

const FONT = "C:/Windows/Fonts/segoeui.ttf";
const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "ogg", "opus", "flac", "wma"];
export const VIDEO_EXT = ["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "3gp", "ts", "mts", "m2ts"];

const clipLen = (c: ClipRecord) => Math.max(0, ((c.endMs ?? c.startMs) - c.startMs) / 1000);
const usable = (c: ClipRecord) => !!c.file && c.endMs !== null && clipLen(c) > 0.2;
const even = (v: number) => Math.max(2, v - (v % 2));

/** An imported video, in the shape the editor uses for clips (it starts at 0, has its own sound). */
const videoClip = (v: LibraryVideo): ClipRecord & { audio: boolean } => ({
  id: v.id,
  meetingId: LIBRARY,
  file: v.file,
  kind: "imported",
  label: v.title,
  startMs: 0,
  endMs: v.durationMs,
  width: v.width,
  height: v.height,
  encrypted: false,
  audio: v.hasAudio,
});

/** Where an edit's clips, sound and files come from: a meeting, or the imported-videos library. */
interface Owner {
  meetingId: string | null;
  /** First path segment of its media URLs. */
  key: string;
  title: string;
  dir: string;
  clips: Array<ClipRecord & { audio?: boolean }>;
  /** The meeting recording (absolute path), if any. */
  audio: string | null;
  lines: TranscriptLine[];
  speakers: Record<string, string>;
}

/**
 * The video library: edits of a meeting's screen recordings (one, or several merged) and of
 * videos imported from outside the app, rendered with FFmpeg into an MP4.
 */
export class VideoService extends EventEmitter {
  private jobs = new Map<string, ChildProcess>();
  private cancelled = new Set<string>();

  constructor(
    private readonly d: {
      videos: VideoProjectRepo;
      library: LibraryVideoRepo;
      libraryDir: string;
      clips: ClipRepo;
      meetings: MeetingRepo;
      encrypt: () => boolean;
      /** Speech recognition over a 16 kHz mono s16le PCM file. */
      transcribe: (pcmPath: string, onProgress: (done: number, total: number) => void) => Promise<Segment[]>;
    },
  ) {
    super();
    mkdirSync(d.libraryDir, { recursive: true });
    // Working folders of an export or scan cut short by a quit or crash (they can hold decrypted
    // copies of recordings).
    for (const name of readdirSync(tmpdir())) {
      if (/^nondh-(edit|ocr|speech)-/.test(name)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
    }
    // An export or import cut short by a quit or crash left a partial file behind.
    for (const p of d.videos.interrupted()) {
      const o = this.ownerOf(p, false);
      if (o) rmSync(join(o.dir, `edit-${p.id}.part.mp4`), { force: true });
      d.videos.setExport(p.id, { status: "error", error: "The export was interrupted. Export again." });
    }
    for (const name of readdirSync(d.libraryDir)) if (name.includes(".part.")) rmSync(join(d.libraryDir, name), { force: true });
    for (const v of d.library.list()) if (v.status === "importing") d.library.failed(v.id, "The import was interrupted. Import the file again.");
  }

  library(): { meetings: LibraryMeeting[]; imported: LibraryVideo[]; projects: VideoProject[] } {
    const meetings: LibraryMeeting[] = [];
    for (const m of this.d.meetings.list({ limit: 100000 })) {
      const clips = this.d.clips.forMeeting(m.id).filter(usable);
      if (clips.length) meetings.push({ id: m.id, title: m.title, startedAt: m.startedAt, clips });
    }
    return { meetings, imported: this.d.library.list(), projects: this.d.videos.list() };
  }

  private meeting(id: string): MeetingRecord {
    const m = this.d.meetings.get(id);
    if (!m) throw new Error("That meeting no longer exists");
    return m;
  }

  private speakerNames(meetingId: string): Record<string, string> {
    return Object.fromEntries(this.d.meetings.speakers(meetingId).map((s) => [s.key, s.name]));
  }

  private ownerOf(p: Pick<VideoProject, "meetingId">, full = true): Owner | null {
    if (p.meetingId === null) {
      return {
        meetingId: null,
        key: LIBRARY,
        title: "Imported videos",
        dir: this.d.libraryDir,
        clips: this.d.library.list().filter((v) => v.status === "ready" && v.file).map(videoClip),
        audio: null,
        lines: [],
        speakers: {},
      };
    }
    const m = this.d.meetings.get(p.meetingId);
    if (!m) return null;
    return {
      meetingId: m.id,
      key: m.id,
      title: m.title,
      dir: m.dir,
      clips: this.d.clips.forMeeting(m.id).filter(usable),
      audio: m.audioFile ? join(m.dir, m.audioFile) : null,
      lines: full ? this.d.meetings.lines(m.id) : [],
      speakers: full ? this.speakerNames(m.id) : {},
    };
  }

  private owner(p: VideoProject): Owner {
    const o = this.ownerOf(p);
    if (!o) throw new Error("That meeting no longer exists");
    return o;
  }

  /**
   * A new edit: one clip, or several merged. Meeting clips must come from the same meeting and
   * are joined in recording order; imported videos (meetingId null) in the order given.
   */
  create(meetingId: string | null, clipIds: string[], title?: string): VideoProject {
    if (meetingId === null) {
      const vids = clipIds.map((id) => this.d.library.get(id)).filter((v): v is LibraryVideo => !!v && v.status === "ready" && !!v.file);
      if (!vids.length || vids.length !== new Set(clipIds).size) throw new Error("Only imported videos that finished importing can be edited");
      const spec = emptySpec(vids.map((v) => clipRef(videoClip(v))));
      const name = title?.trim() || (vids.length > 1 ? `${vids.length} videos merged` : vids[0]!.title);
      return this.d.videos.create({ meetingId: null, title: name, spec });
    }
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
    const o = this.ownerOf(project);
    if (!o) return null;
    const used = new Set(project.spec.segments.map((s) => s.clipId));
    return {
      project,
      source: o.meetingId ? "meeting" : "library",
      meeting: {
        id: o.key,
        title: o.title,
        // Meeting edits: the meeting recording. Imported videos: their own soundtrack.
        hasAudio: o.meetingId ? !!o.audio : o.clips.some((c) => used.has(c.id) && c.audio),
      },
      clips: o.clips,
      lines: o.lines,
      speakers: o.speakers,
    };
  }

  save(id: string, patch: { title?: string; spec?: ProjectSpec }): VideoProject | null {
    return this.d.videos.update(id, patch);
  }

  /** Subtitles rebuilt from the (possibly edited) meeting transcript for the current timeline. */
  subtitlesFor(id: string, spec: ProjectSpec): SubtitleLine[] {
    const p = this.d.videos.get(id);
    const o = p && this.ownerOf(p);
    if (!o?.meetingId) return [];
    return subtitlesFromTranscript(spec, o.clips.map(clipRef), o.lines, (k) => o.speakers[k] ?? k);
  }

  delete(id: string): void {
    const p = this.d.videos.get(id);
    if (!p) return;
    this.cancel(id);
    const o = this.ownerOf(p, false);
    if (o) {
      if (p.exportFile) rmSync(join(o.dir, p.exportFile), { force: true });
      // Added images and audio that no other edit with the same owner uses.
      const others = this.d.videos.forMeeting(p.meetingId).filter((x) => x.id !== id);
      const inUse = new Set(others.flatMap((x) => [...x.spec.images.map((i) => i.file), ...x.spec.audioTracks.map((a) => a.file)]));
      for (const f of [...p.spec.images.map((i) => i.file), ...p.spec.audioTracks.map((a) => a.file)]) {
        if (!inUse.has(f) && f.startsWith(join(o.dir, "video-assets"))) rmSync(f, { force: true });
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

  /** Copies a picked image or audio file next to the edit's media, so it keeps working if the original moves. */
  async pickAsset(id: string, kind: "image" | "audio"): Promise<{ file: string; name: string } | null> {
    const p = this.d.videos.get(id);
    if (!p) return null;
    const o = this.owner(p);
    const r = await dialog.showOpenDialog({
      title: kind === "image" ? "Add an image" : "Add audio",
      properties: ["openFile"],
      filters: [kind === "image" ? { name: "Images", extensions: IMAGE_EXT } : { name: "Audio", extensions: AUDIO_EXT }],
    });
    const src = r.filePaths[0];
    if (r.canceled || !src) return null;
    const dir = join(o.dir, "video-assets");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${randomUUID()}${extname(src).toLowerCase()}`);
    copyFileSync(src, file);
    return { file, name: basename(src) };
  }

  // ---------------------------------------------------------------- importing videos

  /** Asks for video files (unless given) and imports them one after another in the background. */
  async importVideos(paths?: string[]): Promise<LibraryVideo[]> {
    let files = (paths ?? []).filter((p) => VIDEO_EXT.includes(extname(p).slice(1).toLowerCase()));
    if (!paths?.length) {
      const r = await dialog.showOpenDialog({
        title: "Import videos",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "Videos", extensions: VIDEO_EXT }],
      });
      if (r.canceled) return [];
      files = r.filePaths;
    }
    const created = files.map((f) => ({ v: this.d.library.create({ title: basename(f, extname(f)), originalName: basename(f) }), src: f }));
    void (async () => {
      for (const { v, src } of created) await this.importOne(v.id, src);
    })();
    return created.map((c) => c.v);
  }

  private async probe(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath(), ["-hide_banner", "-i", file], { windowsHide: true });
      let err = "";
      child.stderr.on("data", (b: Buffer) => (err += b.toString()));
      child.on("error", reject);
      child.on("close", () => resolve(err)); // exits 1 because no output is given
    });
  }

  /** Copies (or, if the player can't play it, converts) one file into the library folder. */
  private async importOne(id: string, src: string): Promise<void> {
    const dir = this.d.libraryDir;
    let part = "";
    this.progress(id, { phase: "importing", fraction: 0 });
    try {
      if (!existsSync(src)) throw new Error("The file is no longer there");
      const info = parseProbe(await this.probe(src));
      const mode = importMode(info);
      const ext = mode === "webm" ? ".webm" : ".mp4";
      part = join(dir, `${id}.part${ext}`);
      const streams = ["-map", "0:v:0", "-map", "0:a:0?"];
      const args =
        mode === "convert"
          ? [...streams, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
             "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-movflags", "+faststart"]
          : [...streams, "-c", "copy", ...(mode === "mp4" ? ["-movflags", "+faststart"] : [])];
      const total = (info.durationMs ?? 0) / 1000;
      await this.ffmpeg(id, ["-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-i", src, ...args, part], (s) => {
        const t = parseProgress(s);
        if (t !== null && total > 0) this.progress(id, { phase: "importing", fraction: Math.min(0.99, t / total) });
      });
      const name = `${id}${ext}`;
      renameSync(part, join(dir, name));
      part = "";
      const out = parseProbe(await this.probe(join(dir, name)));
      const size = displaySize(out) ?? displaySize(info);
      if (!size) throw new Error("This file has no video");
      this.d.library.ready(id, {
        file: name,
        width: even(size.width),
        height: even(size.height),
        durationMs: out.durationMs ?? info.durationMs ?? 0,
        hasAudio: !!out.audio,
      });
      this.progress(id, { phase: "done", fraction: 1 });
      log.info("video imported", { id, mode, size: `${size.width}x${size.height}`, seconds: (out.durationMs ?? 0) / 1000, audio: !!out.audio });
    } catch (err) {
      if (part) rmSync(part, { force: true });
      const msg = (err as Error).message;
      if (msg === "cancelled") {
        this.d.library.delete(id);
        this.progress(id, { phase: "cancelled", fraction: 0 });
      } else {
        log.error("video import failed", err);
        this.d.library.failed(id, /no video/i.test(msg) ? "This file has no video." : `Couldn't import this file: ${msg}`);
        this.progress(id, { phase: "error", fraction: 0, error: msg });
      }
    } finally {
      this.emit("changed");
    }
  }

  /** Deletes an imported video and every edit that uses it. */
  deleteImported(id: string): void {
    this.cancel(id);
    const v = this.d.library.get(id);
    for (const p of this.d.videos.forMeeting(null)) if (p.spec.segments.some((s) => s.clipId === id)) this.delete(p.id);
    if (v?.file) rmSync(join(this.d.libraryDir, v.file), { force: true });
    this.d.library.delete(id);
  }

  /** "Delete everything": imported videos, their edits and exports. */
  deleteAllImported(): void {
    for (const p of this.d.videos.forMeeting(null)) this.delete(p.id);
    for (const v of this.d.library.list()) this.deleteImported(v.id);
    rmSync(this.d.libraryDir, { recursive: true, force: true });
    mkdirSync(this.d.libraryDir, { recursive: true });
  }

  renameImported(id: string, title: string): void {
    this.d.library.rename(id, title);
  }

  // ---------------------------------------------------------------- rendering helpers

  /** Readable copies of encrypted inputs, in a private temp folder the caller removes. */
  private plainInputs(o: Owner, clips: Owner["clips"], tmp: string) {
    const files: Record<string, { file: string; width: number; height: number; startMs: number; audio?: boolean }> = {};
    for (const c of clips) {
      let file = join(o.dir, c.file!);
      if (c.encrypted || file.endsWith(".enc")) {
        const out = join(tmp, `${c.id}.webm`);
        writeFileSync(out, readAudio(file));
        file = out;
      }
      files[c.id] = { file, width: c.width ?? 1280, height: c.height ?? 720, startMs: c.startMs, audio: c.audio };
    }
    let audio = o.audio;
    if (audio?.endsWith(".enc")) {
      const out = join(tmp, "audio.opus");
      writeFileSync(out, readAudio(audio));
      audio = out;
    }
    return { files, audio };
  }

  private usedClips(o: Owner, spec: ProjectSpec): Owner["clips"] {
    const used = new Set(spec.segments.map((s) => s.clipId));
    const missing = [...used].some((cid) => !o.clips.find((c) => c.id === cid));
    if (missing) throw new Error(o.meetingId ? "A screen recording used in this edit was deleted" : "A video used in this edit was deleted");
    return o.clips.filter((c) => used.has(c.id));
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

  /** Renders the edit to edit-<id>.mp4 next to its media (encrypted like the recordings when that is on). */
  async export(id: string): Promise<void> {
    if (this.jobs.has(id)) return;
    const p = this.d.videos.get(id);
    if (!p) throw new Error("That edit no longer exists");
    const o = this.owner(p);
    const clips = this.usedClips(o, p.spec);
    for (const f of [...p.spec.images.map((i) => i.file), ...p.spec.audioTracks.map((a) => a.file)]) {
      if (!existsSync(f)) throw new Error(`An added file is missing: ${basename(f)}`);
    }

    const tmp = mkdtempSync(join(tmpdir(), "nondh-edit-"));
    const part = join(o.dir, `edit-${id}.part.mp4`);
    this.d.videos.setExport(id, { status: "rendering" });
    this.progress(id, { phase: "preparing", fraction: 0 });
    try {
      const inputs = this.plainInputs(o, clips, tmp);
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
      let final = join(o.dir, `edit-${id}.mp4`);
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
    const o = this.owner(p);
    const safe = p.title.replace(/[<>:"/\\|?*]+/g, " ").trim() || "Nondh AI video";
    const r = await dialog.showSaveDialog({ defaultPath: `${safe}.mp4`, filters: [{ name: "MP4 video", extensions: ["mp4"] }] });
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, readAudio(join(o.dir, p.exportFile)));
    if (p.spec.subtitles.exportSrt && p.spec.subtitles.lines.length) {
      writeFileSync(r.filePath.replace(/\.mp4$/i, "") + ".srt", toSrt(p.spec.subtitles.lines), "utf8");
    }
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  }

  /**
   * Subtitles from what is said in the edit's own sound (imported videos have no meeting
   * transcript): each kept part's audio is run through the offline speech recognizer.
   */
  async speechSubtitles(id: string, spec: ProjectSpec): Promise<SubtitleLine[]> {
    if (this.jobs.has(id)) throw new Error("Busy with this edit, try again when it finishes");
    const p = this.d.videos.get(id);
    if (!p) throw new Error("That edit no longer exists");
    const o = this.owner(p);
    const clips = this.usedClips(o, spec);
    const tmp = mkdtempSync(join(tmpdir(), "nondh-speech-"));
    this.progress(id, { phase: "transcribing", fraction: 0 });
    try {
      const inputs = this.plainInputs(o, clips, tmp);
      const starts = segmentStarts(spec);
      const lines: SubtitleLine[] = [];
      for (const [k, s] of spec.segments.entries()) {
        const c = inputs.files[s.clipId]!;
        if (!c.audio) continue;
        const pcm = join(tmp, `part-${k}.pcm`);
        await this.ffmpeg(id, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(s.in), "-t", String(segLen(s)), "-i", c.file, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", pcm]);
        if (!existsSync(pcm) || statSync(pcm).size < 16000) continue; // under half a second of sound
        const segs = await this.d.transcribe(pcm, (done, total) =>
          this.progress(id, { phase: "transcribing", fraction: Math.min(0.99, (k + done / Math.max(1, total)) / spec.segments.length) }),
        );
        lines.push(...speechToSubtitles(segs, starts[k]!, starts[k]! + segLen(s)));
      }
      this.progress(id, { phase: "done", fraction: 1 });
      log.info("speech subtitles", { id, lines: lines.length });
      return lines;
    } catch (err) {
      const msg = (err as Error).message;
      this.progress(id, { phase: msg === "cancelled" ? "cancelled" : "error", fraction: 0, error: msg });
      throw err;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /**
   * "Find sensitive info": samples the edited timeline, reads text with Windows OCR and suggests
   * blur boxes over passwords, keys, tokens and card numbers. Nothing leaves the computer.
   */
  async findSensitive(id: string, spec: ProjectSpec): Promise<BlurBox[]> {
    if (this.jobs.has(id)) throw new Error("Busy with this edit, try again when it finishes");
    const p = this.d.videos.get(id);
    if (!p) throw new Error("That edit no longer exists");
    const o = this.owner(p);
    const clips = this.usedClips(o, spec);
    const total = duration(spec);
    // About one frame a second; long edits are sampled more sparsely (at most ~600 frames).
    const interval = Math.max(1, Math.ceil(total / 600));
    const tmp = mkdtempSync(join(tmpdir(), "nondh-ocr-"));
    this.progress(id, { phase: "scanning", fraction: 0 });
    try {
      const inputs = this.plainInputs(o, clips, tmp);
      const first = inputs.files[spec.segments[0]!.clipId]!;
      const W = first.width - (first.width % 2);
      const H = first.height - (first.height % 2);
      const frameTimes = new Map<string, number>();
      let t0 = 0;
      for (const [k, s] of spec.segments.entries()) {
        const c = inputs.files[s.clipId]!;
        const len = s.out - s.in;
        const prefix = `s${String(k).padStart(3, "0")}_`;
        // Same scale/pad as the export, so boxes line up with the exported frame. Each frame also
        // as raw gray pixels, to find lines OCR withholds (see hiddenText).
        await this.ffmpeg(id, [
          "-y", "-hide_banner", "-loglevel", "error",
          "-ss", String(s.in), "-t", String(len), "-i", c.file,
          "-filter_complex", `[0:v]fps=1/${interval},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,split[c][g];[g]format=gray[gray]`,
          "-map", "[c]", join(tmp, `${prefix}%05d.png`),
          "-map", "[gray]", "-c:v", "rawvideo", "-f", "image2", join(tmp, `${prefix}%05d.gray`),
        ]);
        for (const f of readdirSync(tmp).filter((f) => f.startsWith(prefix) && f.endsWith(".png")).sort()) {
          const n = Number(f.slice(prefix.length, -4)) - 1;
          frameTimes.set(f, t0 + n * interval);
        }
        t0 += len;
        this.progress(id, { phase: "scanning", fraction: 0.15 * ((k + 1) / spec.segments.length) });
      }
      const frames = await this.ocr(id, tmp, frameTimes.size, (done) =>
        this.progress(id, { phase: "scanning", fraction: 0.15 + 0.85 * (done / Math.max(1, frameTimes.size)) }),
      );
      const timed: OcrFrame[] = frames.flatMap((f) => {
        if (!frameTimes.has(f.frame)) return [];
        const grayFile = join(tmp, f.frame.replace(/\.png$/, ".gray"));
        let hidden: OcrFrame["hidden"] = [];
        if (existsSync(grayFile)) {
          const gray = readFileSync(grayFile);
          if (gray.length === f.width * f.height) hidden = hiddenText(gray, f.width, f.height, f.lines.flatMap((l) => l.words));
          rmSync(grayFile, { force: true });
        }
        return [{ ...f, time: frameTimes.get(f.frame)!, hidden }];
      });
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
