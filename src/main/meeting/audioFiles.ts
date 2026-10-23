import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { app } from "electron";
import { join } from "node:path";
import { getSecret, setSecret } from "../secrets";

const run = promisify(execFile);

export function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require("ffmpeg-static") as string;
  // In the packaged app the binary is unpacked next to app.asar.
  return app.isPackaged ? p.replace("app.asar", "app.asar.unpacked") : p;
}

/** Encode the recorded 16 kHz PCM tracks to one Opus file (stereo for calls: L = me, R = others). */
export async function encodeOpus(pcmFiles: string[], out: string): Promise<void> {
  const inputs = pcmFiles.filter((f) => existsSync(f) && statSync(f).size > 0);
  if (!inputs.length) throw new Error("no audio to encode");
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const f of inputs) args.push("-f", "s16le", "-ar", "16000", "-ac", "1", "-i", f);
  if (inputs.length === 2) args.push("-filter_complex", "[0:a][1:a]amerge=inputs=2[a]", "-map", "[a]");
  args.push("-c:a", "libopus", "-b:a", inputs.length === 2 ? "32k" : "24k", "-application", "voip", out);
  await run(ffmpegPath(), args, { windowsHide: true, maxBuffer: 1 << 20 });
}

/** Decode any audio/video file to 16 kHz mono s16le PCM (for imports). Returns duration in ms. */
export async function decodeToPcm(input: string, out: string): Promise<number> {
  await run(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", out], {
    windowsHide: true,
    maxBuffer: 1 << 20,
  });
  return Math.round((statSync(out).size / 32000) * 1000);
}

// ---- encryption at rest (AES-256-GCM, key kept with DPAPI) ----

function audioKey(): Buffer {
  let k = getSecret("audio-key");
  if (!k) {
    k = randomBytes(32).toString("base64");
    setSecret("audio-key", k);
  }
  return Buffer.from(k, "base64");
}

/** file → file.enc as [12-byte IV][16-byte tag][ciphertext]; the plain file is removed. */
export function encryptFile(path: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", audioKey(), iv);
  const body = Buffer.concat([c.update(readFileSync(path)), c.final()]);
  const out = `${path}.enc`;
  writeFileSync(out, Buffer.concat([iv, c.getAuthTag(), body]));
  rmSync(path, { force: true });
  return out;
}

export function readAudio(path: string): Buffer {
  const data = readFileSync(path);
  if (!path.endsWith(".enc")) return data;
  const d = createDecipheriv("aes-256-gcm", audioKey(), data.subarray(0, 12));
  d.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([d.update(data.subarray(28)), d.final()]);
}

export function meetingAudioPath(dir: string, file: string | null): string | null {
  return file ? join(dir, file) : null;
}
