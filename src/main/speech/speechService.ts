import { utilityProcess, type UtilityProcess } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import type { Settings } from "@shared/settings";
import type { SttResult } from "@shared/types";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";
import { WhisperServer } from "./whisperServer";
import { cloudTranscribe } from "./cloudStt";
import { parakeetDir, whisperFile, vadFile } from "../models/registry";

type Pending = { resolve: (r: { text: string; decodeMs: number }) => void; reject: (e: Error) => void };

/**
 * One dictation = one session. Parakeet sessions stream audio to the worker as it is captured;
 * Whisper and cloud sessions buffer and transcribe at the end.
 */
export class SpeechService {
  private worker: UtilityProcess | null = null;
  private workerReady: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
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
    if (s.stt.engine === "parakeet") await this.ensureWorker();
    else if (s.stt.engine === "whisper") await this.whisper.ensure(whisperFile(this.modelsDir(), s.stt.whisperModel), this.threads());
  }

  private ensureWorker(): Promise<void> {
    const s = this.settings();
    if (this.workerReady) return this.workerReady;
    const w = utilityProcess.fork(join(__dirname, "speechWorker.js"), [], { serviceName: "Nondh AI speech" });
    this.worker = w;
    this.workerReady = new Promise<void>((resolve, reject) => {
      w.on("message", (m: WorkerResponse) => {
        if (m.type === "ready") resolve();
        else if (m.type === "log") console.log("[speech]", m.message);
        else if (m.type === "final") {
          this.pending.get(m.id)?.resolve({ text: m.text, decodeMs: m.decodeMs });
          this.pending.delete(m.id);
        } else if (m.type === "error") {
          console.error("[speech] error", m.message);
          if (m.id) {
            this.pending.get(m.id)?.reject(new Error(m.message));
            this.pending.delete(m.id);
          } else reject(new Error(m.message));
        }
      });
      w.on("exit", (code) => {
        console.error(`[speech] worker exited (${code})`);
        this.worker = null;
        this.workerReady = null;
        for (const p of this.pending.values()) p.reject(new Error("speech worker exited"));
        this.pending.clear();
        reject(new Error(`speech worker exited (${code})`));
      });
    });
    this.post({
      type: "init",
      parakeetDir: parakeetDir(this.modelsDir(), s.stt.parakeetModel),
      vadModel: vadFile(this.modelsDir()),
      threads: this.threads(),
    });
    return this.workerReady;
  }

  private post(m: WorkerRequest): void {
    this.worker?.postMessage(m);
  }

  begin(): string {
    const id = randomUUID();
    const engine = this.settings().stt.engine;
    this.sessionEngine.set(id, engine);
    if (engine === "parakeet") {
      void this.ensureWorker().then(() => this.post({ type: "begin", id }));
    } else {
      this.buffers.set(id, []);
    }
    return id;
  }

  push(id: string, samples: Float32Array): void {
    const engine = this.sessionEngine.get(id);
    if (engine === "parakeet") {
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
      await this.workerReady;
      const r = await new Promise<{ text: string; decodeMs: number }>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.post({ type: "end", id });
      });
      return { text: r.text, engine, model: s.stt.parakeetModel, cloud: false, ms: Date.now() - t0 };
    }
    const chunks = this.buffers.get(id) ?? [];
    this.buffers.delete(id);
    const samples = concat(chunks);
    if (engine === "whisper") {
      await this.whisper.ensure(whisperFile(this.modelsDir(), s.stt.whisperModel), this.threads());
      const text = await this.whisper.transcribe(samples, { language: s.stt.language, translateToEnglish: opts.translateToEnglish });
      return { text, engine, model: s.stt.whisperModel, cloud: false, ms: Date.now() - t0 };
    }
    const text = await cloudTranscribe(samples, { ...s.stt.cloud, language: s.stt.language, prompt: opts.prompt });
    return { text, engine, model: s.stt.cloud.model, cloud: true, ms: Date.now() - t0 };
  }

  /** Transcribe a whole buffer with the local Parakeet engine (file import, re-transcribe). */
  async transcribeBuffer(samples: Float32Array): Promise<string> {
    await this.ensureWorker();
    const id = randomUUID();
    const r = await new Promise<{ text: string }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: "transcribe", id, samples });
    });
    return r.text;
  }

  /** Called when the model or engine setting changes. */
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
