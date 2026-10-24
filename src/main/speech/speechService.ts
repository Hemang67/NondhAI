import { utilityProcess, type UtilityProcess } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import type { Settings } from "@shared/settings";
import type { SttResult } from "@shared/types";
import type { Channel, Segment, Turn } from "@shared/meeting/types";
import type { ClusterInfo, WorkerRequest, WorkerResponse } from "./workerProtocol";
import { WhisperServer } from "./whisperServer";
import { cloudTranscribe } from "./cloudStt";
import { existsSync } from "node:fs";
import { diarizationFiles, isInstalled, modelDef, parakeetDir, whisperFile, vadFile } from "../models/registry";
import { log } from "../log";

type Handler = {
  resolve: (m: WorkerResponse) => void;
  reject: (e: Error) => void;
  onSegment?: (s: Segment) => void;
  onProgress?: (done: number, total: number) => void;
};

/**
 * Front end for the speech utility process plus the Whisper/cloud engines.
 * Dictation: begin/push/end. Meetings: live streams, final pass, diarization, embeddings.
 */
export class SpeechService {
  private worker: UtilityProcess | null = null;
  private workerReady: Promise<void> | null = null;
  private readonly handlers = new Map<string, Handler>();
  readonly whisper = new WhisperServer();
  private buffers = new Map<string, Float32Array[]>();
  private sessionEngine = new Map<string, Settings["stt"]["engine"]>();

  constructor(
    private readonly settings: () => Settings,
    private readonly modelsDir: () => string,
  ) {}

  private threads(): number {
    return Math.max(2, Math.min(8, cpus().length - 2));
  }

  /** Load the configured engine so the first dictation doesn't pay model-load time. */
  async warm(): Promise<void> {
    const s = this.settings();
    await this.ensureWorker(); // meetings always use the worker
    if (s.stt.engine === "whisper") await this.whisper.ensure(whisperFile(this.modelsDir(), s.stt.whisperModel), this.threads());
  }

  get speakerModelsReady(): boolean {
    return diarizationFiles(this.modelsDir()) !== null;
  }

  private ensureWorker(): Promise<void> {
    if (this.workerReady) return this.workerReady;
    const s = this.settings();
    const parakeet = modelDef(s.stt.parakeetModel);
    if (!parakeet || !isInstalled(this.modelsDir(), parakeet) || !existsSync(vadFile(this.modelsDir()))) {
      return Promise.reject(new Error("The speech model is still downloading. See Models for progress, then try again."));
    }
    const w = utilityProcess.fork(join(__dirname, "speechWorker.js"), [], { serviceName: "Nondh AI speech" });
    this.worker = w;
    this.workerReady = new Promise<void>((resolve, reject) => {
      w.on("message", (m: WorkerResponse) => {
        if (m.type === "ready") return resolve();
        if (m.type === "log") return log.info("[speech]", m.message);
        if (m.type === "segment") return this.handlers.get(m.id)?.onSegment?.(m.segment);
        if (m.type === "progress") return this.handlers.get(m.id)?.onProgress?.(m.done, m.total);
        if (m.type === "error") {
          log.error("[speech] error", m.message);
          if (!m.id) {
            // Failed to load: drop this worker so the next call starts a fresh one.
            if (this.worker === w) {
              this.worker = null;
              this.workerReady = null;
            }
            w.kill();
            return reject(new Error(m.message));
          }
          this.handlers.get(m.id)?.reject(new Error(m.message));
          this.handlers.delete(m.id);
          return;
        }
        const h = this.handlers.get(m.id);
        this.handlers.delete(m.id);
        h?.resolve(m);
      });
      w.on("exit", (code) => {
        log.error(`[speech] worker exited (${code})`);
        reject(new Error(`speech worker exited (${code})`));
        if (this.worker === w) {
          this.worker = null;
          this.workerReady = null;
        }
        for (const h of this.handlers.values()) h.reject(new Error("speech worker exited"));
        this.handlers.clear();
      });
    });
    this.post({
      type: "init",
      parakeetDir: parakeetDir(this.modelsDir(), s.stt.parakeetModel),
      vadModel: vadFile(this.modelsDir()),
      threads: this.threads(),
      diarization: diarizationFiles(this.modelsDir()) ?? undefined,
    });
    return this.workerReady;
  }

  private post(m: WorkerRequest): void {
    this.worker?.postMessage(m);
  }

  /** Send a request and wait for the response that carries the same id. */
  private async call<T extends WorkerResponse>(m: WorkerRequest & { id: string }, extra: Partial<Handler> = {}): Promise<T> {
    await this.ensureWorker();
    return new Promise<T>((resolve, reject) => {
      this.handlers.set(m.id, { resolve: resolve as (r: WorkerResponse) => void, reject, ...extra });
      this.post(m);
    });
  }

  // ---- dictation ----

  begin(): string {
    const id = randomUUID();
    const engine = this.settings().stt.engine;
    this.sessionEngine.set(id, engine);
    if (engine === "parakeet") void this.ensureWorker().then(() => this.post({ type: "begin", id }));
    else this.buffers.set(id, []);
    return id;
  }

  push(id: string, samples: Float32Array): void {
    if (this.sessionEngine.get(id) === "parakeet") {
      // Order is preserved: begin is posted only after the worker is ready, and so are these.
      void this.workerReady?.then(() => this.post({ type: "audio", id, samples }));
    } else {
      this.buffers.get(id)?.push(samples);
    }
  }

  abort(id: string): void {
    if (this.sessionEngine.get(id) === "parakeet") this.post({ type: "abort", id });
    this.buffers.delete(id);
    this.sessionEngine.delete(id);
  }

  async end(id: string, opts: { translateToEnglish?: boolean; prompt?: string } = {}): Promise<SttResult> {
    const s = this.settings();
    const engine = this.sessionEngine.get(id) ?? s.stt.engine;
    this.sessionEngine.delete(id);
    const t0 = Date.now();
    if (engine === "parakeet") {
      const r = await this.call<Extract<WorkerResponse, { type: "final" }>>({ type: "end", id });
      return { text: r.text, engine, model: s.stt.parakeetModel, cloud: false, ms: Date.now() - t0 };
    }
    const samples = concat(this.buffers.get(id) ?? []);
    this.buffers.delete(id);
    if (engine === "whisper") {
      await this.whisper.ensure(whisperFile(this.modelsDir(), s.stt.whisperModel), this.threads());
      const text = await this.whisper.transcribe(samples, { language: s.stt.language, translateToEnglish: opts.translateToEnglish });
      return { text, engine, model: s.stt.whisperModel, cloud: false, ms: Date.now() - t0 };
    }
    const text = await cloudTranscribe(samples, { ...s.stt.cloud, language: s.stt.language, prompt: opts.prompt });
    return { text, engine, model: s.stt.cloud.model, cloud: true, ms: Date.now() - t0 };
  }

  /** Transcribe a whole buffer with the local engine (voice commands, re-transcribe). */
  async transcribeBuffer(samples: Float32Array): Promise<string> {
    const r = await this.call<Extract<WorkerResponse, { type: "final" }>>({ type: "transcribe", id: randomUUID(), samples });
    return r.text;
  }

  // ---- meetings ----

  async streamBegin(channel: Channel, offsetMs: number, onSegment: (s: Segment) => void): Promise<string> {
    await this.ensureWorker();
    const id = randomUUID();
    // The handler stays registered until stream-done so live segments reach onSegment.
    this.handlers.set(id, { resolve: () => {}, reject: () => {}, onSegment });
    this.post({ type: "stream-begin", id, channel, offsetMs });
    return id;
  }

  streamPush(id: string, samples: Float32Array): void {
    this.post({ type: "stream-audio", id, samples });
  }

  streamEnd(id: string): Promise<void> {
    const h = this.handlers.get(id);
    // No worker means no stream-done will ever arrive; don't leave Stop waiting forever.
    if (!this.worker) {
      this.handlers.delete(id);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.handlers.set(id, { ...(h ?? { reject: () => {} }), resolve: () => resolve(), reject: () => resolve() });
      this.post({ type: "stream-end", id });
    });
  }

  async finalPass(path: string, channel: Channel, onProgress?: (done: number, total: number) => void): Promise<Segment[]> {
    const r = await this.call<Extract<WorkerResponse, { type: "segments" }>>({ type: "final-pass", id: randomUUID(), path, channel }, { onProgress });
    log.info(`final pass ${channel}: ${r.segments.length} segments in ${r.ms} ms`);
    return r.segments;
  }

  async diarize(path: string, numSpeakers?: number): Promise<{ turns: Turn[]; clusters: ClusterInfo[] }> {
    if (!this.speakerModelsReady) throw new Error("Speaker models are not downloaded yet");
    const r = await this.call<Extract<WorkerResponse, { type: "diarized" }>>({ type: "diarize", id: randomUUID(), path, numSpeakers, threshold: 0.5 });
    log.info(`diarized ${path}: ${r.clusters.length} speakers, ${r.turns.length} turns in ${r.ms} ms`);
    return { turns: r.turns, clusters: r.clusters };
  }

  async embed(samples: Float32Array): Promise<number[]> {
    const r = await this.call<Extract<WorkerResponse, { type: "embedding" }>>({ type: "embed", id: randomUUID(), samples });
    return r.embedding;
  }

  /** Called when the model or engine setting changes (or speaker models arrive). */
  reload(): void {
    this.worker?.kill();
    this.worker = null;
    this.workerReady = null;
    this.whisper.stop();
  }

  stop(): void {
    this.worker?.kill();
    this.whisper.stop();
  }
}

export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
