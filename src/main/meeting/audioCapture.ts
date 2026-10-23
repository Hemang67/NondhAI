import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { binPath } from "../paths";

export interface CaptureEvents {
  frame: (channel: 0 | 1, pcm: Int16Array) => void;
  level: (mic: number, system: number) => void;
  started: (info: { mic: string; system: string; aec: boolean }) => void;
  deviceChanged: (stream: string, name: string) => void;
  error: (message: string) => void;
  exit: (code: number | null) => void;
}

/**
 * Wrapper for native vd-audio.exe: 16 kHz mono mic (channel 0) and system loopback (channel 1)
 * frames on stdout, JSON events on stderr.
 */
export class AudioCapture extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending: Buffer = Buffer.alloc(0);

  start(opts: { loopback: boolean; aec: boolean }): void {
    const args = [...(opts.loopback ? [] : ["--no-loopback"]), ...(opts.aec && opts.loopback ? ["--aec"] : [])];
    const p = spawn(binPath("vd-audio.exe"), args, { windowsHide: true });
    this.proc = p;
    p.stdout.on("data", (d: Buffer) => this.onData(d));
    createInterface({ input: p.stderr }).on("line", (line) => this.onEvent(line));
    p.on("exit", (code) => {
      this.proc = null;
      this.emit("exit", code);
    });
    p.on("error", (err) => this.emit("error", err.message));
  }

  private onData(d: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, d]) : d;
    let off = 0;
    while (this.pending.length - off >= 4) {
      if (this.pending[off] !== 0x41) {
        off++; // resync on a corrupted stream rather than give up
        continue;
      }
      const ch = this.pending[off + 1]! as 0 | 1;
      const n = this.pending.readUInt16LE(off + 2);
      if (this.pending.length - off < 4 + n * 2) break;
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = this.pending.readInt16LE(off + 4 + i * 2);
      this.emit("frame", ch, pcm);
      off += 4 + n * 2;
    }
    this.pending = this.pending.subarray(off);
  }

  private onEvent(line: string): void {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    switch (e.event) {
      case "level":
        this.emit("level", e.mic as number, e.system as number);
        break;
      case "started":
        this.emit("started", { mic: String(e.mic), system: String(e.system ?? ""), aec: !!e.aec });
        break;
      case "device-changed":
        this.emit("deviceChanged", String(e.stream), String(e.name));
        break;
      case "error":
        this.emit("error", String(e.message));
        break;
    }
  }

  stop(): Promise<void> {
    const p = this.proc;
    if (!p) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        p.kill();
        resolve();
      }, 3000);
      p.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      p.stdin.end("QUIT\n");
    });
  }
}
