import { EventEmitter } from "node:events";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { assembleTranscript } from "@shared/meeting/assemble";
import { LiveTranscript } from "@shared/meeting/live";
import { buildSummaryMessages, chunkTranscript, mergeSummaries, parseSummary } from "@shared/meeting/summary";
import { transcriptForLlm } from "@shared/meeting/export";
import { buildImportedTranscript, parseTranscript } from "@shared/meeting/transcriptImport";
import type { Segment, TranscriptLine } from "@shared/meeting/types";
import type { MeetingKind, MeetingRecord } from "@shared/types";
import type { Settings } from "@shared/settings";
import { AudioCapture } from "./audioCapture";
import { decodeToPcm, encodeOpus, encryptFile, restorePcm } from "./audioFiles";
import { isTranscriptFile, readTranscriptFile } from "./transcriptFiles";
import type { SpeechService } from "../speech/speechService";
import type { ClipRepo, MeetingRepo, PeopleRepo } from "../storage/meetings";
import type { LlmClient } from "../llm/llm";
import { SPEAKER_MODEL } from "../models/registry";
import { userDataPath } from "../paths";
import { log } from "../log";

export interface RecordingState {
  id: string;
  title: string;
  kind: MeetingKind;
  startedAt: number;
  mic: string;
  system: string;
}

interface Active extends RecordingState {
  dir: string;
  capture: AudioCapture;
  files: { mic: number; system: number | null };
  streams: { mic: string; system: string | null };
  live: LiveTranscript;
  buffers: { mic: Float32Array[]; system: Float32Array[] };
  lastSync: number;
  releaseTimer: NodeJS.Timeout;
  journalTimer: NodeJS.Timeout;
  bytes: number;
}

const toFloat = (pcm: Int16Array) => {
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i]! / 32768;
  return f;
};

/**
 * Records meetings (mic + system as separate tracks), shows a live transcript, and after the
 * call runs the accurate pass: full re-transcription, echo removal, diarization, speaker
 * matching, Opus encoding and the summary. Audio is written to disk as it arrives and fsynced
 * every few seconds, so a crash or reboot loses at most a few seconds; unfinished recordings
 * are picked up and processed at the next start.
 */
export class MeetingService extends EventEmitter {
  private active: Active | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly d: {
      settings: () => Settings;
      speech: SpeechService;
      meetings: MeetingRepo;
      people: PeopleRepo;
      clips?: ClipRepo;
      llm: LlmClient;
      llmAvailable: (provider: string) => boolean;
    },
  ) {
    super();
  }

  get recording(): RecordingState | null {
    if (!this.active) return null;
    const { id, title, kind, startedAt, mic, system } = this.active;
    return { id, title, kind, startedAt, mic, system };
  }

  private baseDir(): string {
    const dir = this.d.settings().meetings.dir || userDataPath("meetings");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private starting: Promise<RecordingState> | null = null;
  private startingId: string | null = null;

  /** Start recording; concurrent calls (double clicks, hotkey + toast) share one recording. */
  start(opts: { kind: "call" | "room"; title?: string; sourceApp?: string | null }): Promise<RecordingState> {
    if (this.active) return Promise.resolve(this.recording!);
    if (!this.starting) this.starting = this.doStart(opts).finally(() => (this.starting = null));
    return this.starting;
  }

  private async doStart(opts: { kind: "call" | "room"; title?: string; sourceApp?: string | null }): Promise<RecordingState> {
    const s = this.d.settings();
    const id = randomUUID();
    const dir = join(this.baseDir(), id);
    mkdirSync(dir, { recursive: true });
    const startedAt = Date.now();
    const title =
      opts.title?.trim() ||
      `${opts.sourceApp ? `${opts.sourceApp} call` : opts.kind === "room" ? "In-person meeting" : "Call"} — ${new Date(startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
    const loopback = opts.kind === "call";
    const live = new LiveTranscript(opts.kind);
    const onLine = (lines: TranscriptLine[]) => {
      for (const l of lines) {
        this.d.meetings.appendLine(id, l);
        this.emit("line", id, l);
      }
    };
    // Start transcription first: if the speech engine isn't ready this throws before a
    // "recording" row exists that nothing could ever stop.
    const mic = await this.d.speech.streamBegin("mic", 0, (seg) => live.addMic(seg, Date.now()));
    const streams = {
      mic,
      system: loopback ? await this.d.speech.streamBegin("system", 0, (seg: Segment) => onLine(live.addSystem(seg))).catch((err) => {
        void this.d.speech.streamEnd(mic);
        throw err;
      }) : null,
    };

    this.startingId = id;
    this.d.meetings.create({ id, title, kind: opts.kind, dir, sourceApp: opts.sourceApp ?? null, startedAt });
    writeFileSync(join(dir, "journal.json"), JSON.stringify({ id, kind: opts.kind, startedAt, status: "recording" }));

    const capture = new AudioCapture();
    const files = { mic: openSync(join(dir, "mic.pcm"), "a"), system: loopback ? openSync(join(dir, "system.pcm"), "a") : null };
    const a: Active = {
      id,
      title,
      kind: opts.kind,
      startedAt,
      mic: "",
      system: "",
      dir,
      capture,
      files,
      streams,
      live,
      buffers: { mic: [], system: [] },
      lastSync: Date.now(),
      releaseTimer: setInterval(() => onLine(live.release(Date.now())), 500),
      journalTimer: setInterval(() => this.writeJournal(), 5000),
      bytes: 0,
    };
    this.active = a;

    capture.on("frame", (ch: 0 | 1, pcm: Int16Array) => this.onFrame(a, ch, pcm));
    capture.on("level", (mic: number, system: number) => this.emit("level", mic, system));
    capture.on("started", (info: { mic: string; system: string }) => {
      a.mic = info.mic;
      a.system = info.system;
      this.emit("state", this.recording);
    });
    capture.on("deviceChanged", (stream: string, name: string) => {
      log.info(`meeting ${id}: ${stream} device changed to ${name}`);
      if (stream === "mic") a.mic = name;
      else a.system = name;
      this.emit("state", this.recording);
    });
    capture.on("error", (msg: string) => {
      log.error(`meeting ${id}: capture error: ${msg}`);
      this.emit("error", msg);
    });
    capture.on("exit", (code: number | null) => {
      if (this.active === a) {
        log.error(`meeting ${id}: capture exited unexpectedly (${code}); stopping`);
        void this.stop("audio capture exited");
      }
    });
    capture.start({ loopback, aec: s.meetings.aec });
    log.info(`meeting ${id} recording started (${opts.kind}, aec=${s.meetings.aec})`);
    this.emit("state", this.recording);
    return this.recording!;
  }

  private onFrame(a: Active, ch: 0 | 1, pcm: Int16Array): void {
    const fd = ch === 0 ? a.files.mic : a.files.system;
    if (fd === null) return;
    writeSync(fd, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    if (ch === 0) a.bytes += pcm.byteLength;
    const buf = ch === 0 ? a.buffers.mic : a.buffers.system;
    buf.push(toFloat(pcm));
    if (buf.length >= 25) {
      // ~250 ms per push keeps IPC overhead low and the live view responsive.
      const joined = new Float32Array(buf.reduce((n, b) => n + b.length, 0));
      let off = 0;
      for (const b of buf) {
        joined.set(b, off);
        off += b.length;
      }
      buf.length = 0;
      const sid = ch === 0 ? a.streams.mic : a.streams.system;
      if (sid) this.d.speech.streamPush(sid, joined);
    }
    if (Date.now() - a.lastSync > 3000) {
      a.lastSync = Date.now();
      fsyncSync(a.files.mic);
      if (a.files.system !== null) fsyncSync(a.files.system);
    }
  }

  private writeJournal(): void {
    const a = this.active;
    if (!a) return;
    const durationMs = Math.round((a.bytes / 32000) * 1000);
    writeFileSync(join(a.dir, "journal.json"), JSON.stringify({ id: a.id, kind: a.kind, startedAt: a.startedAt, status: "recording", durationMs }));
    this.d.meetings.update(a.id, { durationMs });
  }

  /** by: what asked for the stop, for the log. */
  async stop(by = "unknown"): Promise<string | null> {
    const a = this.active;
    if (!a) {
      // A row can say "recording" with nothing behind it (crash, failed start); finish those.
      this.recover(["recording"]);
      this.emit("changed");
      return null;
    }
    this.active = null;
    clearInterval(a.releaseTimer);
    clearInterval(a.journalTimer);
    await a.capture.stop();
    for (const [ch, sid] of [["mic", a.streams.mic], ["system", a.streams.system]] as const) {
      const buf = ch === "mic" ? a.buffers.mic : a.buffers.system;
      if (sid && buf.length) this.d.speech.streamPush(sid, Float32Array.from(buf.flatMap((b) => Array.from(b))));
    }
    await Promise.all([this.d.speech.streamEnd(a.streams.mic), a.streams.system ? this.d.speech.streamEnd(a.streams.system) : null]);
    for (const l of a.live.release(Date.now(), true)) {
      this.d.meetings.appendLine(a.id, l);
      this.emit("line", a.id, l);
    }
    for (const fd of [a.files.mic, a.files.system]) {
      if (fd === null) continue;
      fsyncSync(fd);
      closeSync(fd);
    }
    const durationMs = Math.round((a.bytes / 32000) * 1000);
    this.d.meetings.update(a.id, { status: "processing", endedAt: Date.now(), durationMs });
    log.info(`meeting ${a.id} stopped by ${by} after ${Math.round(durationMs / 1000)} s; processing`);
    this.emit("state", null);
    this.enqueue(a.id);
    return a.id;
  }

  private enqueue(id: string): void {
    this.queue = this.queue.then(() => this.process(id)).catch((err) => log.error("meeting processing failed", err));
  }

  /** Recordings left in "recording" (crash, reboot) or "processing" are finished on startup. */
  recover(statuses: Array<"recording" | "processing"> = ["recording", "processing"]): void {
    for (const m of statuses.flatMap((s) => this.d.meetings.listByStatus(s))) {
      if (m.id === this.active?.id || m.id === this.startingId) continue; // being recorded right now
      const mic = join(m.dir, "mic.pcm");
      if (!existsSync(mic) && !existsSync(join(m.dir, "mixed.pcm"))) {
        this.d.meetings.update(m.id, { status: "failed", error: "Recording files are missing." });
        continue;
      }
      const bytes = existsSync(mic) ? statSync(mic).size : 0;
      log.info(`recovering meeting ${m.id} (${Math.round(bytes / 32000)} s of audio)`);
      this.d.meetings.update(m.id, { status: "processing", recovered: m.status === "recording", durationMs: Math.round((bytes / 32000) * 1000) });
      this.enqueue(m.id);
    }
  }

  /** Import audio/video files; each becomes a meeting processed like an in-person recording. */
  async importFiles(paths: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const p of paths) {
      const id = randomUUID();
      const dir = join(this.baseDir(), id);
      mkdirSync(dir, { recursive: true });
      const startedAt = statSync(p).mtimeMs;
      this.d.meetings.create({ id, title: basename(p).replace(/\.[^.]+$/, ""), kind: "import", dir, startedAt: Math.round(startedAt) });
      this.d.meetings.update(id, { status: "processing" });
      ids.push(id);
      this.queue = this.queue
        .then(async () => {
          if (isTranscriptFile(p)) return this.importTranscript(id, p);
          const ms = await decodeToPcm(p, join(dir, "mixed.pcm"));
          this.d.meetings.update(id, { durationMs: ms });
          await this.process(id);
        })
        .catch((err) => {
          log.error(`import of ${p} failed`, err);
          this.d.meetings.update(id, { status: "failed", error: String((err as Error).message ?? err) });
          this.emit("changed");
        });
    }
    this.emit("changed");
    return ids;
  }

  /**
   * Use a transcript file (from Meet, Teams, Zoom, Otter, Supernormal, or a Nondh AI export) as
   * the meeting's transcript, replacing any it had, then summarize it.
   */
  async importTranscript(id: string, path: string): Promise<void> {
    const m = this.d.meetings.get(id);
    if (!m) throw new Error("meeting not found");
    const turns = parseTranscript(await readTranscriptFile(path), basename(path));
    if (!turns.length) throw new Error("No transcript text was found in this file.");
    const { lines, speakers, durationMs } = buildImportedTranscript(turns, (name) => {
      const p = this.d.people.findByName(name);
      return p ? { id: p.id, isMe: p.isMe } : null;
    });
    this.d.meetings.replaceLines(id, lines, true);
    this.d.meetings.setSpeakers(id, speakers);
    this.d.meetings.update(id, { status: "ready", error: null, ...(m.durationMs ? {} : { durationMs }) });
    log.info(`meeting ${id}: imported transcript ${basename(path)}: ${lines.length} lines, ${speakers.length} speakers`);
    this.emit("changed");
    const s = this.d.settings();
    if (!s.meetings.summarize) return;
    await this.summarize(id).catch((err: Error) => {
      log.warn("summary failed", err);
      throw new Error(`The transcript was imported, but the summary failed: ${err.message}`);
    });
  }

  /** Re-run the final pass (e.g. after enrolling a voice or downloading speaker models). */
  reprocess(id: string): void {
    this.d.meetings.update(id, { status: "processing", error: null });
    this.emit("changed");
    this.enqueue(id);
  }

  private async process(id: string): Promise<void> {
    const m = this.d.meetings.get(id);
    if (!m) return;
    const t0 = Date.now();
    this.emit("changed");
    try {
      const mixed = join(m.dir, "mixed.pcm");
      const micPcm = join(m.dir, "mic.pcm");
      const sysPcm = join(m.dir, "system.pcm");
      const call = m.kind === "call";
      const primaryPath = m.kind === "import" ? mixed : micPcm;
      const progress = (stage: string) => (done: number, total: number) => this.emit("progress", id, `${stage} ${done}/${total}`);
      const hasAudio = (p: string) => existsSync(p) && statSync(p).size > 32000;
      const pcm = m.kind === "import" ? [mixed] : call ? [micPcm, sysPcm] : [micPcm];

      // A processed meeting keeps only its compressed audio: unpack it again for a re-process.
      // Without any audio, stop here rather than replace the transcript with nothing.
      let restored = false;
      if (!pcm.some(hasAudio)) {
        if (!m.audioFile || !existsSync(join(m.dir, m.audioFile))) {
          if (this.d.meetings.lines(id).length) throw new Error("The recording's audio is no longer available, so it can't be processed again.");
        } else {
          this.emit("progress", id, "Preparing audio");
          await restorePcm(join(m.dir, m.audioFile), pcm);
          restored = true;
        }
      }

      const primary = hasAudio(primaryPath) ? await this.d.speech.finalPass(primaryPath, call ? "mic" : "mixed", progress("Transcribing")) : [];
      const system = call && hasAudio(sysPcm) ? await this.d.speech.finalPass(sysPcm, "system", progress("Transcribing others")) : [];
      const diarizeTarget = call ? sysPcm : primaryPath;
      const diarizeSegs = call ? system : primary;
      let diar: Awaited<ReturnType<SpeechService["diarize"]>> = { turns: [], clusters: [] };
      if (diarizeSegs.length && this.d.speech.speakerModelsReady) {
        this.emit("progress", id, "Identifying speakers");
        diar = await this.d.speech.diarize(diarizeTarget);
      }
      const out = assembleTranscript({
        kind: m.kind,
        primary,
        system,
        turns: diar.turns,
        clusters: diar.clusters,
        voices: this.d.people.voices(SPEAKER_MODEL),
      });
      this.d.meetings.replaceLines(id, out.lines, true);
      this.d.meetings.setSpeakers(id, out.speakers);
      log.info(
        `meeting ${id}: ${out.lines.length} lines, ${out.speakers.length} speakers, ${out.echoWordsRemoved} echo words removed`,
      );

      // Compress the audio; keep the PCM only if encoding fails. Unpacked copies of audio that is
      // already saved are just removed.
      const s = this.d.settings();
      if (restored) for (const f of pcm) rmSync(f, { force: true });
      else if (pcm.some(hasAudio)) {
        this.emit("progress", id, "Compressing audio");
        let audio = join(m.dir, "audio.opus");
        await encodeOpus(pcm, audio);
        if (s.meetings.encryptAudio) audio = encryptFile(audio);
        for (const f of pcm) rmSync(f, { force: true });
        const keep = s.meetings.keepAudioDays;
        this.d.meetings.update(id, {
          audioFile: basename(audio),
          audioEncrypted: s.meetings.encryptAudio,
          audioExpiresAt: keep > 0 ? m.startedAt + keep * 86400000 : null,
        });
      }
      this.d.meetings.update(id, { status: "ready", error: null });
      this.emit("changed");
      log.info(`meeting ${id} processed in ${Math.round((Date.now() - t0) / 1000)} s`);
      if (s.meetings.summarize && out.lines.length) await this.summarize(id).catch((err) => log.warn("summary failed", err));
    } catch (err) {
      log.error(`meeting ${id} processing failed`, err);
      this.d.meetings.update(id, { status: "failed", error: String((err as Error).message ?? err) });
    }
    this.emit("changed");
  }

  async summarize(id: string): Promise<void> {
    const m = this.d.meetings.get(id);
    if (!m) return;
    const s = this.d.settings();
    // Prefer the configured summary model; fall back to the local one if its key is missing.
    let target = s.llm.summaries;
    if (!this.d.llmAvailable(target.provider)) target = { provider: "local", model: "" };
    if (!this.d.llmAvailable(target.provider)) throw new Error("No language model is available for summaries");
    this.emit("progress", id, "Summarizing");
    const speakers = Object.fromEntries(this.d.meetings.speakers(id).map((sp) => [sp.key, { name: sp.name }]));
    const transcript = transcriptForLlm({ lines: this.d.meetings.lines(id), speakers });
    // Small local models have small context windows (8k tokens, shared by the transcript piece and
    // the detailed notes): summarize in pieces and merge.
    const local = target.provider === "local";
    const parts = chunkTranscript(transcript, local ? 8000 : 400000);
    const summaries = [];
    for (const part of parts) {
      const r = await this.d.llm.chat(target, buildSummaryMessages(part, { title: m.title, attendees: m.attendees }), {
        maxTokens: local ? 5000 : 8000,
        temperature: 0.2,
        effort: "medium",
      });
      const parsed = parseSummary(r.text);
      if (parsed) summaries.push(parsed);
    }
    if (!summaries.length) throw new Error("The model did not return a usable summary");
    const summary = mergeSummaries(summaries);
    // Name the meeting from its content, unless someone gave it a real title.
    const autoTitle = /^(.+ call|Call|In-person meeting) — /.test(m.title);
    this.d.meetings.update(id, { summary, ...(autoTitle && summary.title ? { title: summary.title } : {}) });
    this.emit("changed");
  }

  /** Delete recorded audio for meetings past their retention date. */
  applyRetention(): void {
    const now = Date.now();
    const keep = this.d.settings().meetings.keepAudioDays;
    for (const m of this.d.meetings.list({ limit: 100000 })) {
      const expires = m.audioExpiresAt ?? (keep > 0 ? m.startedAt + keep * 86400000 : null);
      if (m.audioFile && expires !== null && expires < now) this.deleteAudio(m);
    }
  }

  /** Deletes the recordings (audio, screen clips and videos made from them); transcripts and summaries stay. */
  deleteAudio(m: MeetingRecord): void {
    for (const f of ["audio.opus", "audio.opus.enc", "mic.pcm", "system.pcm", "mixed.pcm"]) rmSync(join(m.dir, f), { force: true });
    for (const c of this.d.clips?.forMeeting(m.id) ?? []) {
      if (c.file) rmSync(join(m.dir, c.file), { force: true });
      this.d.clips?.setFile(c.id, null);
    }
    this.d.meetings.update(m.id, { audioFile: null, audioExpiresAt: null });
    // Edited videos contain the same audio and screen content.
    this.emit("audioDeleted", m);
  }

  deleteMeeting(m: MeetingRecord): void {
    rmSync(m.dir, { recursive: true, force: true });
    this.d.meetings.purge(m.id);
  }
}
