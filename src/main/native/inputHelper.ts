import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { binPath } from "../paths";

export interface ForegroundInfo {
  pid: number;
  exePath: string;
  title: string;
  appName: string;
}

type Waiter = (line: string) => void;

/**
 * Wrapper around native vd-input.exe: chord events in, paste/copy/foreground requests out.
 * Restarts the helper if it dies (e.g. killed by the user) with a small backoff.
 */
export class InputHelper extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private bindings: Record<string, string> = {};
  private waiters: Record<"PASTED" | "COPIED" | "FG", Waiter[]> = { PASTED: [], COPIED: [], FG: [] };
  private stopping = false;
  private restarts = 0;

  constructor(private readonly args: string[] = []) {
    super();
  }

  start(): void {
    this.stopping = false;
    const exe = binPath("vd-input.exe");
    const p = spawn(exe, this.args, { windowsHide: true });
    this.proc = p;
    createInterface({ input: p.stdout }).on("line", (line) => this.onLine(line));
    p.stderr.on("data", (d) => console.error("[vd-input]", String(d).trim()));
    p.on("exit", (code) => {
      this.proc = null;
      for (const list of Object.values(this.waiters)) list.splice(0).forEach((w) => w("ERR helper exited"));
      if (this.stopping) return;
      const delay = Math.min(30000, 500 * 2 ** this.restarts++);
      console.error(`[vd-input] exited with ${code}, restarting in ${delay} ms`);
      setTimeout(() => this.start(), delay);
    });
    p.on("error", (err) => console.error("[vd-input] spawn failed", err));
    this.applyBindings();
  }

  stop(): void {
    this.stopping = true;
    this.proc?.stdin.write("QUIT\n");
    setTimeout(() => this.proc?.kill(), 500);
  }

  setBindings(b: Record<string, string>): void {
    this.bindings = b;
    this.applyBindings();
  }

  private applyBindings(): void {
    if (!this.proc) return;
    const lines = ["CLEAR", ...Object.entries(this.bindings).filter(([, s]) => s).map(([n, s]) => `BIND ${n} ${s}`)];
    this.proc.stdin.write(lines.join("\n") + "\n");
  }

  private onLine(line: string): void {
    const [kind, ...rest] = line.split(" ");
    const arg = rest.join(" ");
    switch (kind) {
      case "READY":
        this.restarts = 0;
        this.emit("ready");
        return;
      case "DOWN":
      case "UP":
      case "CANCEL": {
        const [name = "", ...detail] = arg.split(" ");
        this.emit("chord", kind.toLowerCase(), name, Date.now(), detail.join(" "));
        return;
      }
      case "ESC":
        this.emit("escape", Date.now());
        return;
      case "PASTED":
      case "COPIED":
      case "FG":
        this.waiters[kind].shift()?.(arg);
        return;
      case "ERR":
        console.error("[vd-input]", arg);
        return;
    }
  }

  private request(cmd: string, kind: keyof InputHelper["waiters"], timeoutMs = 3000): Promise<string> {
    return new Promise((resolve) => {
      if (!this.proc) return resolve("ERR not running");
      let done = false;
      const finish = (s: string) => {
        if (done) return;
        done = true;
        resolve(s);
      };
      this.waiters[kind].push(finish);
      setTimeout(() => {
        const i = this.waiters[kind].indexOf(finish);
        if (i >= 0) this.waiters[kind].splice(i, 1);
        finish("ERR timeout");
      }, timeoutMs);
      this.proc.stdin.write(cmd + "\n");
    });
  }

  async paste(withShift = false): Promise<"ok" | string> {
    return this.request(withShift ? "PASTE shift" : "PASTE", "PASTED");
  }

  async copy(): Promise<"ok" | string> {
    return this.request("COPY", "COPIED");
  }

  async foreground(): Promise<ForegroundInfo | null> {
    const r = await this.request("FG", "FG", 1000);
    if (r.startsWith("ERR")) return null;
    const [pid, exePath = "", title = ""] = r.split("\t");
    return { pid: Number(pid), exePath, title, appName: basename(exePath, ".exe") };
  }
}
