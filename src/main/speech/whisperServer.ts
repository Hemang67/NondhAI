import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { encodeWav } from "@shared/audio/wav";
import { binPath, userDataPath } from "../paths";
import { freePort, waitForHttp } from "../llm/llamaServer";

/** whisper.cpp whisper-server child process; kept warm so the model stays loaded. */
export class WhisperServer {
  private proc: ChildProcess | null = null;
  private key = "";
  private port = 0;
  private starting: Promise<void> | null = null;

  async ensure(modelFile: string, threads: number): Promise<void> {
    const key = `${modelFile}|${threads}`;
    if (this.proc && this.key === key && this.proc.exitCode === null) return;
    if (this.starting && this.key === key) return this.starting;
    this.stop();
    this.key = key;
    this.starting = this.launch(modelFile, threads).finally(() => (this.starting = null));
    return this.starting;
  }

  private async launch(modelFile: string, threads: number): Promise<void> {
    if (!existsSync(modelFile)) throw new Error(`Whisper model not found: ${modelFile}`);
    this.port = await freePort();
    const dir = binPath("whisper", "Release");
    const p = spawn(
      `${dir}\\whisper-server.exe`,
      ["-m", modelFile, "--host", "127.0.0.1", "--port", String(this.port), "-t", String(threads), "-nt"],
      { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const log = createWriteStream(userDataPath("logs", "whisper-server.log"), { flags: "a" });
    p.stdout?.pipe(log);
    p.stderr?.pipe(log);
    this.proc = p;
    try {
      await waitForHttp(`http://127.0.0.1:${this.port}/`, 60000, p);
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  async transcribe(samples: Float32Array, opts: { language: string; translateToEnglish?: boolean }): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([encodeWav(samples, 16000)], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "json");
    form.append("temperature", "0");
    form.append("language", opts.language || "auto");
    if (opts.translateToEnglish) form.append("translate", "true");
    const r = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: "POST", body: form });
    if (!r.ok) throw new Error(`whisper-server ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as { text?: string };
    return (j.text ?? "").trim();
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
