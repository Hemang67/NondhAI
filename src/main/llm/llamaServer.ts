import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { binPath, userDataPath } from "../paths";

mkdirSync(userDataPath("logs"), { recursive: true });

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export async function waitForHttp(url: string, timeoutMs: number, proc?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) throw new Error(`process exited with ${proc.exitCode}`);
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${url}`);
}

/**
 * A llama.cpp llama-server child process on a private localhost port (OpenAI-compatible API).
 * Started on demand, kept warm while the app runs, restarted if the model or backend changes.
 */
export class LlamaServer {
  private proc: ChildProcess | null = null;
  private key = "";
  private port = 0;
  private starting: Promise<string> | null = null;

  async ensure(modelFile: string, gpu: boolean): Promise<string> {
    const key = `${modelFile}|${gpu}`;
    if (this.proc && this.key === key && this.proc.exitCode === null) return this.baseUrl;
    if (this.starting && this.key === key) return this.starting;
    this.stop();
    this.key = key;
    this.starting = this.launch(modelFile, gpu).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  private async launch(modelFile: string, gpu: boolean): Promise<string> {
    if (!existsSync(modelFile)) throw new Error(`LLM model not found: ${modelFile}`);
    const dir = binPath(gpu ? "llama-vulkan" : "llama-cpu");
    this.port = await freePort();
    const args = [
      "-m", modelFile,
      "--host", "127.0.0.1",
      "--port", String(this.port),
      "-c", "8192",
      "-np", "1", // one slot, so the shared cleanup prompt prefix stays cached between calls
      "--no-webui",
      ...(gpu ? ["-ngl", "99"] : ["-t", "8"]),
    ];
    const t0 = Date.now();
    // Server output goes to a log file for troubleshooting.
    const p = spawn(join(dir, "llama-server.exe"), args, { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const log = createWriteStream(userDataPath("logs", "llama-server.log"), { flags: "a" });
    p.stdout?.pipe(log);
    p.stderr?.pipe(log);
    this.proc = p;
    try {
      await waitForHttp(`http://127.0.0.1:${this.port}/health`, 60000, p);
    } catch (err) {
      this.stop();
      throw err;
    }
    console.log(`[llama] ${modelFile} ready on ${this.port} (${gpu ? "vulkan" : "cpu"}) in ${Date.now() - t0} ms`);
    return this.baseUrl;
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
