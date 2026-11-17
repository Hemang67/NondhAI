/**
 * Speaker statistics for the user's own recorded meetings (no ground truth, counts only).
 * Runs under Electron because the recordings are encrypted with a key that only the OS user's
 * DPAPI (via Electron safeStorage) can unwrap. It never touches the app's own profile: the two
 * files it needs are copied to a temporary profile that is deleted afterwards. Audio is decrypted
 * and decoded in memory only; the report holds durations and cluster counts, nothing spoken.
 *
 *   node scripts/speaker-eval.mjs real --appdata "%APPDATA%/Nondh AI" --meetings <dir> --models <dir>
 *        [--embedding <onnx>] [--threshold 0.5] [--report <json>]
 */
import { app, safeStorage } from "electron";
import { createDecipheriv } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { basename, dirname, join } from "node:path";
import { createDiarizer, refineTurns } from "../../src/main/speech/diarizer";
import { RATE, channelCount, decodeBuffer } from "./audio";
import { DIARIZATION } from "@shared/meeting/policy";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sherpa = require("sherpa-onnx-node");

const argv = process.argv.slice(process.argv.indexOf("real") + 1);
const opt = (k: string, d?: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};

const appdata = opt("appdata")!;
const profile = mkdtempSync(join(tmpdir(), "nondh-eval-"));
copyFileSync(join(appdata, "Local State"), join(profile, "Local State"));
app.setPath("userData", profile);
app.disableHardwareAcceleration();

function decrypt(path: string, key: Buffer): Buffer {
  const data = readFileSync(path);
  if (!path.endsWith(".enc")) return data;
  const d = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  d.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([d.update(data.subarray(28)), d.final()]);
}

function histogram(totals: number[]): Record<string, number> {
  const b = { "<2s": 0, "2-5s": 0, "5-15s": 0, "15-60s": 0, ">60s": 0 };
  for (const ms of totals) {
    const s = ms / 1000;
    if (s < 2) b["<2s"]++;
    else if (s < 5) b["2-5s"]++;
    else if (s < 15) b["5-15s"]++;
    else if (s < 60) b["15-60s"]++;
    else b[">60s"]++;
  }
  return b;
}

async function main(): Promise<void> {
  const keyFile = join(appdata, "secrets", "audio-key.bin");
  const key = existsSync(keyFile) ? Buffer.from(safeStorage.decryptString(readFileSync(keyFile)), "base64") : null;
  const models = opt("models")!;
  const threshold = Number(opt("threshold", "0.5"));
  const threads = Math.max(2, Math.min(8, cpus().length - 2));
  const segmentation = join(models, "speaker", "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx");
  const camplus = createDiarizer(sherpa, { segmentation, embedding: join(models, "speaker", "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx"), threads });
  const embedding = opt("embedding");
  const better = embedding ? createDiarizer(sherpa, { segmentation, embedding, threads }) : null;
  const refine = { ...DIARIZATION.refine, ...(opt("merge") ? { mergeThreshold: Number(opt("merge")) } : {}) };

  const meetingsDir = opt("meetings")!;
  const rows = [];
  // Most recent first; --limit N keeps the run short.
  const ids = readdirSync(meetingsDir)
    .map((id) => ({ id, at: statSync(join(meetingsDir, id)).mtimeMs }))
    .sort((x, y) => y.at - x.at)
    .map((x) => x.id)
    .slice(0, Number(opt("limit", "1000")));
  for (const id of ids) {
    const dir = join(meetingsDir, id);
    const file = ["audio.opus.enc", "audio.opus"].map((f) => join(dir, f)).find(existsSync);
    if (!file || (file.endsWith(".enc") && !key)) continue;
    const buf = decrypt(file, key!);
    const stereo = (await channelCount(buf)) === 2;
    // Calls are stereo (left = me, right = others) and diarized on the right; others are mono.
    const x = await decodeBuffer(buf, stereo ? "right" : undefined);
    const sec = x.length / RATE;
    if (sec < 60) continue;
    const t0 = Date.now();
    const raw = camplus.segment(x, { threshold });
    const t1 = Date.now();
    const row: Record<string, unknown> = {
      meeting: id.slice(0, 8),
      kind: stereo ? "call (system track)" : "room/import",
      minutes: +(sec / 60).toFixed(1),
      speechMin: +(raw.reduce((n, t) => n + t.end - t.start, 0) / 60000).toFixed(1),
      today: { clusters: new Set(raw.map((t) => t.cluster)).size, sizes: histogram(clusterTotals(raw)), seconds: Math.round((t1 - t0) / 1000) },
    };
    if (better) {
      const t2 = Date.now();
      const raw2 = better.segment(x, { threshold: DIARIZATION.threshold });
      const r = refineTurns(x, raw2, (s) => better.embed(s), refine);
      row.improved = {
        stage1Clusters: new Set(raw2.map((t) => t.cluster)).size,
        speakers: r.clusters.length,
        sizes: histogram(r.clusters.map((c) => c.totalMs)),
        uncertainTurns: r.turns.filter((t) => t.uncertain).length,
        seconds: Math.round((Date.now() - t2) / 1000),
      };
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  const out = opt("report");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), threshold, embedding: embedding ? basename(embedding) : null, refine, meetings: rows }, null, 2));
  }
}

function clusterTotals(turns: Array<{ start: number; end: number; cluster: number }>): number[] {
  const m = new Map<number, number>();
  for (const t of turns) m.set(t.cluster, (m.get(t.cluster) ?? 0) + t.end - t.start);
  return [...m.values()];
}

app
  .whenReady()
  .then(main)
  .catch((e: unknown) => console.error(e))
  .finally(() => {
    rmSync(profile, { recursive: true, force: true });
    app.quit();
  });
