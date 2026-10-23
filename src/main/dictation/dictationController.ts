import { HotkeyMachine, type ChordMode, type HotkeyAction } from "@shared/hotkeyMachine";
import { runCleanup } from "@shared/cleanup/pipeline";
import type { DictionaryEntry } from "@shared/cleanup/rules";
import type { DictationMode, PillState } from "@shared/types";
import type { Settings } from "@shared/settings";
import type { InputHelper, ForegroundInfo } from "../native/inputHelper";
import type { SpeechService } from "../speech/speechService";
import type { LlmClient } from "../llm/llm";
import type { Store } from "../storage/store";
import { pasteText } from "../paste";
import { log } from "../log";

export interface RecorderBridge {
  start(sessionId: string): Promise<void>;
  /** Resolves once the renderer has flushed its last audio chunk. */
  stop(sessionId: string): Promise<void>;
}

export interface DictationDeps {
  settings: () => Settings;
  input: InputHelper;
  speech: SpeechService;
  llm: LlmClient;
  store: Store;
  recorder: RecorderBridge;
  setPill: (s: PillState) => void;
  llmAvailable: () => boolean;
  onDictation?: () => void;
}

const MIN_AUDIO_MS = 350;
const MAX_RECORDING_MS = 10 * 60 * 1000;

interface Active {
  sessionId: string;
  mode: DictationMode;
  locked: boolean;
  startedAt: number;
  target: ForegroundInfo | null;
  audioMs: number;
  maxTimer: NodeJS.Timeout;
}

export class DictationController {
  private readonly machine: HotkeyMachine;
  private active: Active | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly d: DictationDeps) {
    const s = d.settings();
    this.machine = new HotkeyMachine({ holdMs: s.holdMs, doubleTapMs: s.doubleTapMs });
    d.input.on("chord", (kind: "down" | "up" | "cancel", name: string, t: number, detail: string) =>
      this.onChord(kind, name, t, detail),
    );
    d.input.on("escape", (t: number) => this.apply(this.machine.escape(t)));
  }

  private onChord(kind: "down" | "up" | "cancel", name: string, t: number, detail = ""): void {
    if (name !== "dictate" && name !== "translate" && name !== "assistant") return;
    log.info(`chord ${kind} ${name}${detail ? ` (${detail})` : ""} state=${this.machine.state}`);
    if (kind === "down") {
      if (this.busy && this.machine.state === "idle") return; // still pasting the last one
      this.apply(this.machine.down(name as ChordMode, t));
    } else if (kind === "up") {
      this.apply(this.machine.up(t));
      if (this.machine.state === "awaitingSecondTap") this.scheduleTick();
    } else {
      this.apply(this.machine.cancel(t));
    }
  }

  private scheduleTick(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => this.apply(this.machine.tick(Date.now())), this.d.settings().doubleTapMs + 10);
  }

  /** Tray / UI toggle: start or stop a locked recording. */
  toggleFromUi(mode: DictationMode = "dictate"): void {
    if (this.active) {
      this.machine.reset();
      void this.stop();
    } else {
      void this.start(mode).then(() => {
        if (this.active) {
          this.active.locked = true;
          this.pushPill();
        }
      });
    }
  }

  private apply(actions: HotkeyAction[]): void {
    for (const a of actions) {
      switch (a.type) {
        case "start":
          void this.start(a.mode);
          break;
        case "setMode":
          if (this.active) {
            this.active.mode = a.mode;
            this.pushPill();
          }
          break;
        case "lock":
          if (this.active) {
            this.active.locked = true;
            this.pushPill();
          }
          break;
        case "stop":
          void this.stop();
          break;
        case "abort":
          this.abort();
          break;
      }
    }
  }

  private pushPill(): void {
    if (this.active) this.d.setPill({ kind: "listening", mode: this.active.mode, locked: this.active.locked });
  }

  private async start(mode: DictationMode): Promise<void> {
    if (this.active) return;
    const sessionId = this.d.speech.begin();
    const target = await this.d.input.foreground().catch(() => null);
    this.active = {
      sessionId,
      mode,
      locked: false,
      startedAt: Date.now(),
      target,
      audioMs: 0,
      maxTimer: setTimeout(() => {
        this.machine.reset();
        void this.stop();
      }, MAX_RECORDING_MS),
    };
    this.pushPill();
    try {
      await this.d.recorder.start(sessionId);
    } catch (err) {
      log.error("recorder failed to start", err);
      this.cleanupActive();
      this.machine.reset();
      this.flashError(`Microphone unavailable: ${(err as Error).message}`);
    }
  }

  /** Audio chunk from the renderer (16 kHz mono float). */
  onAudio(sessionId: string, samples: Float32Array): void {
    if (!this.active || this.active.sessionId !== sessionId) return;
    this.active.audioMs += (samples.length / 16000) * 1000;
    this.d.speech.push(sessionId, samples);
  }

  private abort(): void {
    if (!this.active) return;
    log.info("dictation aborted");
    const { sessionId } = this.active;
    void this.d.recorder.stop(sessionId);
    this.d.speech.abort(sessionId);
    this.cleanupActive();
    this.d.setPill({ kind: "hidden" });
  }

  private cleanupActive(): void {
    if (this.active) clearTimeout(this.active.maxTimer);
    this.active = null;
  }

  private async stop(): Promise<void> {
    const a = this.active;
    if (!a) return;
    this.cleanupActive();
    this.busy = true;
    const stopAt = Date.now();
    const s = this.d.settings();
    const cloudStt = s.stt.engine === "cloud";
    const cloudLlm = s.cleanup.llm.provider !== "local";
    this.d.setPill({ kind: "processing", mode: a.mode, cloud: cloudStt || (a.mode === "translate" && cloudLlm) });
    try {
      await this.d.recorder.stop(a.sessionId);
      if (a.audioMs < MIN_AUDIO_MS) {
        log.info(`dictation ignored: only ${Math.round(a.audioMs)} ms of audio`);
        this.d.speech.abort(a.sessionId);
        this.d.setPill({ kind: "hidden" });
        return;
      }
      const dict = this.d.store.listDictionary().map(
        (r): DictionaryEntry => ({ term: r.term, kind: r.kind, match: r.match ?? undefined, replacement: r.replacement ?? undefined }),
      );
      const stt = await this.d.speech.end(a.sessionId, { prompt: dict.map((x) => x.term).join(", ") });
      const sttDone = Date.now();
      if (!stt.text.trim()) {
        this.flashError("No speech detected");
        return;
      }
      const translateTo = a.mode === "translate" ? s.translate.target : undefined;
      let cloudUsed = stt.cloud;
      const llmCall =
        this.d.llmAvailable() && (s.cleanup.enabled || translateTo)
          ? async (messages: Parameters<LlmClient["chat"]>[1]) => {
              const r = await this.d.llm.chat(s.cleanup.llm, messages, { maxTokens: 1024, temperature: 0.1, effort: "low" });
              cloudUsed ||= r.cloud;
              return r.text;
            }
          : null;
      const outcome = s.cleanup.enabled || translateTo
        ? await runCleanup({ raw: stt.text, dictionary: dict, mode: s.cleanup.llmMode, translateTo }, llmCall)
        : { text: stt.text.trim(), usedLlm: false, llmRejected: false };
      if (outcome.llmError) log.warn("cleanup LLM failed, used rules", outcome.llmError);
      if (outcome.rejectedOutput !== undefined) log.warn("cleanup LLM output rejected:", JSON.stringify(outcome.rejectedOutput));
      if (outcome.translationFailed) {
        this.flashError(outcome.usedLlm ? "Translation failed — nothing was pasted" : "Translation needs a language model");
        return;
      }
      const cleanDone = Date.now();
      const text = outcome.text;
      if (!text) {
        this.flashError("No speech detected");
        return;
      }
      const paste = await pasteText(this.d.input, text, { ...s.paste, target: a.target });
      const doneAt = Date.now();
      this.d.store.addDictation({
        rawText: stt.text,
        cleanText: text,
        mode: a.mode,
        engine: stt.engine,
        model: stt.model,
        durationMs: Math.round(a.audioMs),
        latencyMs: doneAt - stopAt,
        appName: a.target?.appName ?? null,
        cloudUsed,
      });
      log.info(
        `dictation ${a.mode} audio=${Math.round(a.audioMs)}ms stt=${sttDone - stopAt}ms cleanup=${cleanDone - sttDone}ms` +
          ` (llm=${outcome.usedLlm}${outcome.llmRejected ? ",rejected" : ""}) paste=${doneAt - cleanDone}ms total=${doneAt - stopAt}ms` +
          ` app=${a.target?.appName ?? "?"} pasted=${paste.pasted}`,
      );
      this.d.onDictation?.();
      if (!paste.pasted) this.flashError("Couldn't paste — the text is on your clipboard");
      else this.d.setPill({ kind: "hidden" });
    } catch (err) {
      log.error("dictation failed", err);
      this.flashError((err as Error).message);
    } finally {
      this.busy = false;
    }
  }

  private flashError(message: string): void {
    log.warn(`dictation: ${message}`);
    this.d.setPill({ kind: "error", message });
    setTimeout(() => this.d.setPill({ kind: "hidden" }), 3000);
  }
}
