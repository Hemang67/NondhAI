import { EventEmitter } from "node:events";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ModelInfo } from "@shared/types";
import { MODELS, isInstalled, modelDef, modelPath, type ModelDef } from "./registry";

const run = promisify(execFile);

/** Download, list and delete local models. Downloads resume from a .part file. */
export class ModelManager extends EventEmitter {
  private active = new Map<string, { received: number; total: number; abort: AbortController }>();

  constructor(private readonly modelsDir: () => string) {
    super();
  }

  list(): ModelInfo[] {
    const dir = this.modelsDir();
    return MODELS.filter((m) => m.engine !== "vad").map((m) => {
      const d = this.active.get(m.id);
      return {
        id: m.id,
        engine: m.engine as ModelInfo["engine"],
        name: m.name,
        sizeMb: m.sizeMb,
        description: m.description,
        installed: isInstalled(dir, m),
        downloading: d ? { received: d.received, total: d.total } : undefined,
      };
    });
  }

  /** Small models every feature depends on (VAD, speaker models, search embeddings): ~60 MB. */
  async ensureRequired(): Promise<void> {
    for (const id of ["silero-vad", "pyannote-segmentation-3.0", "campplus-speaker-embedding", "bge-small-embedding"]) {
      const m = modelDef(id)!;
      if (!isInstalled(this.modelsDir(), m)) await this.download(id);
    }
  }

  async download(id: string): Promise<void> {
    const m = modelDef(id);
    if (!m) throw new Error(`unknown model ${id}`);
    if (this.active.has(id)) return;
    const dir = this.modelsDir();
    const target = modelPath(dir, m);
    const part = `${m.archiveDir ? join(dir, m.engine, `${m.id}.tar.bz2`) : target}.part`;
    mkdirSync(dirname(part), { recursive: true });
    const abort = new AbortController();
    const state = { received: 0, total: m.sizeMb * 1024 * 1024, abort };
    this.active.set(id, state);
    this.emit("progress", id);
    try {
      const have = existsSync(part) ? statSync(part).size : 0;
      const res = await fetch(m.url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: abort.signal, redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
      const resumed = res.status === 206;
      state.received = resumed ? have : 0;
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len) state.total = state.received + len;
      let lastEmit = 0;
      const body = Readable.fromWeb(res.body as never);
      body.on("data", (c: Buffer) => {
        state.received += c.length;
        if (Date.now() - lastEmit > 250) {
          lastEmit = Date.now();
          this.emit("progress", id);
        }
      });
      await pipeline(body, createWriteStream(part, { flags: resumed ? "a" : "w" }));
      if (m.archiveDir) {
        await extractTarBz2(part, join(dir, m.engine));
        rmSync(part, { force: true });
        if (!isInstalled(dir, m)) throw new Error("archive did not contain the expected model files");
      } else {
        renameSync(part, target);
      }
    } finally {
      this.active.delete(id);
      this.emit("progress", id);
    }
  }

  cancel(id: string): void {
    this.active.get(id)?.abort.abort();
  }

  delete(id: string): void {
    const m = modelDef(id);
    if (!m) return;
    rmSync(modelPath(this.modelsDir(), m), { recursive: true, force: true });
    this.emit("progress", id);
  }
}

async function extractTarBz2(archive: string, into: string): Promise<void> {
  // Windows ships bsdtar, which handles .tar.bz2 natively.
  await run("C:\\Windows\\System32\\tar.exe", ["-xjf", archive, "-C", into], { windowsHide: true });
}

export type { ModelDef };
