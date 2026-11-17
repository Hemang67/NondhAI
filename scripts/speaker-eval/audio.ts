import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { decodeWav, encodeWav } from "@shared/audio/wav";

export const RATE = 16000;

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const ffmpeg = (): string => require("ffmpeg-static") as string;

function run(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg(), ["-hide_banner", "-loglevel", "error", ...args], { windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${Buffer.concat(err).toString()}`))));
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

const toF32 = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const fromF32 = (x: Float32Array) => Buffer.from(x.buffer, x.byteOffset, x.byteLength);
const F32 = ["-f", "f32le", "-ar", String(RATE), "-ac", "1"];

/** Any audio file → 16 kHz mono float. */
export async function decodeFile(path: string): Promise<Float32Array> {
  if (path.toLowerCase().endsWith(".wav")) {
    const w = decodeWav(readFileSync(path));
    if (w.sampleRate === RATE) return w.samples;
  }
  return toF32(await run(["-i", path, "-vn", ...F32, "pipe:1"]));
}

/** Audio held in memory (e.g. a decrypted recording) → 16 kHz float; `channel` picks L or R. */
export async function decodeBuffer(buf: Buffer, channel?: "left" | "right"): Promise<Float32Array> {
  const pick = channel ? ["-af", `pan=mono|c0=${channel === "left" ? "c0" : "c1"}`] : [];
  return toF32(await run(["-i", "pipe:0", "-vn", ...pick, ...F32, "pipe:1"], buf));
}

export async function channelCount(buf: Buffer): Promise<number> {
  // With no output ffmpeg exits with an error, but it prints the stream layout first.
  const probe = await new Promise<string>((resolve) => {
    const p = spawn(ffmpeg(), ["-hide_banner", "-i", "pipe:0"], { windowsHide: true });
    const err: Buffer[] = [];
    p.stderr.on("data", (d: Buffer) => err.push(d));
    p.on("close", () => resolve(Buffer.concat(err).toString()));
    p.stdin.on("error", () => {});
    p.stdin.end(buf);
  });
  return /Audio:.*\bstereo\b/.test(probe) ? 2 : 1;
}

/** Run samples through an ffmpeg audio filter chain (16 kHz mono in and out). */
export async function filter(samples: Float32Array, chain: string): Promise<Float32Array> {
  return toF32(await run([...F32, "-i", "pipe:0", "-af", chain, ...F32, "pipe:1"], fromF32(samples)));
}

/** Encode to Opus and back, like the app's saved recordings (VoIP mode). */
export async function opusRoundTrip(samples: Float32Array, bitrate = "24k"): Promise<Float32Array> {
  const ogg = await run([...F32, "-i", "pipe:0", "-c:a", "libopus", "-b:a", bitrate, "-application", "voip", "-f", "ogg", "pipe:1"], fromF32(samples));
  return toF32(await run(["-i", "pipe:0", ...F32, "pipe:1"], ogg));
}

export function writeWav(path: string, samples: Float32Array): void {
  writeFileSync(path, encodeWav(samples, RATE));
}

/**
 * Speech regions by short-term energy: 30 ms frames above `relDb` below the peak, pauses
 * shorter than `bridgeMs` bridged. Returns sample ranges.
 */
export function speechRegions(x: Float32Array, opts: { relDb?: number; bridgeMs?: number } = {}): Array<[number, number]> {
  const frame = Math.round(RATE * 0.03);
  const n = Math.floor(x.length / frame);
  const db = new Float32Array(n);
  let peak = -Infinity;
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) e += x[i]! * x[i]!;
    db[f] = 10 * Math.log10(e / frame + 1e-12);
    peak = Math.max(peak, db[f]!);
  }
  const floor = peak + (opts.relDb ?? -35);
  const bridge = Math.round((opts.bridgeMs ?? 300) / 30);
  const out: Array<[number, number]> = [];
  let start = -1;
  let lastOn = -1;
  for (let f = 0; f < n; f++) {
    if (db[f]! < floor) continue;
    if (start < 0) start = f;
    else if (f - lastOn > bridge) {
      out.push([start * frame, (lastOn + 1) * frame]);
      start = f;
    }
    lastOn = f;
  }
  if (start >= 0) out.push([start * frame, (lastOn + 1) * frame]);
  return out;
}
