/**
 * Speaker-identification evaluation (docs/SPEAKER_ID_AUDIT.md, Phase 0).
 *
 *   node scripts/speaker-eval.mjs synth --libri <LibriSpeech/dev-clean-2> --out <dir>
 *   node scripts/speaker-eval.mjs run --data <dir> [--data <dir>] --models <models dir> --report <file.json>
 *        [--threshold 0.5] [--only a,b] [--label name]
 *
 * `run` scores every <name>.wav that has a <name>.rttm next to it, using the same diarizer code
 * the app's speech worker runs. Meetings with a "group" in <name>.json are processed in name
 * order as one series: after each meeting every voice is "named" (enrolled) as the user would,
 * and later meetings are scored on who they recognise.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cpus } from "node:os";
import { createDiarizer, refineTurns } from "../../src/main/speech/diarizer";
import { longestOverlapMs } from "@shared/meeting/refine";
import type { Turn } from "@shared/meeting/types";
import { parseRttm, scoreDiarization, type LabeledTurn } from "@shared/meeting/eval/diarization";
import { equalErrorRate, ratesAt, thresholdForFar, type Trial } from "@shared/meeting/eval/identity";
import { cosine, profileScore, type KnownVoice } from "@shared/meeting/speakers";
import { DIARIZATION, MATCH_POLICY } from "@shared/meeting/policy";
import { decodeFile, RATE, speechRegions } from "./audio";
import { calibrate, collectTrials, evaluate, type MeetingOut } from "./identity";
import { SUITE, indexLibriSpeech, renderScenario } from "./render";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sherpa = require("sherpa-onnx-node");

function args(): { cmd: string; opt: Map<string, string[]> } {
  const [cmd = "", ...rest] = process.argv.slice(2);
  const opt = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i]!.startsWith("--")) continue;
    const k = rest[i]!.slice(2);
    const v = rest[i + 1] && !rest[i + 1]!.startsWith("--") ? rest[++i]! : "true";
    opt.set(k, [...(opt.get(k) ?? []), v]);
  }
  return { cmd, opt };
}

const one = (o: Map<string, string[]>, k: string, d?: string) => o.get(k)?.[0] ?? d;

async function synth(o: Map<string, string[]>): Promise<void> {
  const pool = indexLibriSpeech(one(o, "libri")!);
  const out = one(o, "out")!;
  const only = one(o, "only")?.split(",");
  console.log(`${pool.length} LibriSpeech speakers`);
  for (const sc of SUITE) {
    if (only && !only.includes(sc.name)) continue;
    const t0 = Date.now();
    const r = await renderScenario(sc, pool, out);
    console.log(`${sc.name}: ${Math.round(r.seconds)} s rendered in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}

interface FileResult {
  file: string;
  group: string | null;
  audioSec: number;
  diarizeMs: number;
  rtf: number;
  refSpeakers: number;
  clusters: number;
  /** Clusters with less than 5 s of speech in total. */
  tinyClusters: number;
  der: number;
  miss: number;
  falseAlarm: number;
  confusion: number;
  splitSpeakers: number;
  mergedSpeakers: number;
  purity: number;
  coverage: number;
  identity?: { correct: number; falseMatch: number; missed: number; correctUnknown: number; noEmbedding: number };
}

async function runEval(o: Map<string, string[]>): Promise<void> {
  const models = one(o, "models")!;
  const threshold = Number(one(o, "threshold", "0.5"));
  const only = one(o, "only")?.split(",");
  const threads = Math.max(2, Math.min(8, cpus().length - 2));
  const embedding = one(o, "embedding") ?? join(models, "speaker", "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx");
  const embTag = basename(embedding, ".onnx");
  const diarizer = createDiarizer(sherpa, {
    segmentation: join(models, "speaker", "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"),
    embedding,
    threads,
  });
  const list = (k: string, d: string) => one(o, k, d)!.split(",").map(Number);
  const combos = one(o, "refine")
    ? list("merge", "0.5").flatMap((m) =>
        list("min-cluster", "4000").flatMap((mc) =>
          list("cannot-link", "1000").map((cl) => ({ mergeThreshold: m, minClusterMs: mc, cannotLinkMs: cl, reassignThreshold: Number(one(o, "reassign", "0.5")) })),
        ),
      )
    : [null];
  const cacheDir = one(o, "cache", join("eval-data", "cache"))!;
  mkdirSync(cacheDir, { recursive: true });
  const files = (o.get("data") ?? [])
    .flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".wav")).map((f) => join(d, f)))
    .filter((f) => existsSync(f.replace(/\.wav$/, ".rttm")))
    .filter((f) => !only || only.includes(basename(f, ".wav")))
    .sort();

  // Stage 1 (sherpa) and piece embeddings are cached on disk: sweeps over stage-2 settings then
  // take seconds instead of a full diarization per setting.
  const loaded = [];
  for (const wav of files) {
    const name = basename(wav, ".wav");
    const meta = existsSync(wav.replace(/\.wav$/, ".json")) ? JSON.parse(readFileSync(wav.replace(/\.wav$/, ".json"), "utf8")) : {};
    const ref = parseRttm(readFileSync(wav.replace(/\.wav$/, ".rttm"), "utf8")).get(name) ?? [];
    const samples = await decodeFile(wav);
    const rawPath = join(cacheDir, `${name}.${embTag}.${threshold}.raw.json`);
    let stage1: { raw: Turn[]; ms: number };
    if (existsSync(rawPath)) stage1 = JSON.parse(readFileSync(rawPath, "utf8"));
    else {
      const t0 = Date.now();
      stage1 = { raw: diarizer.segment(samples, { threshold }), ms: 0 };
      stage1.ms = Date.now() - t0;
      writeFileSync(rawPath, JSON.stringify(stage1));
    }
    const embPath = join(cacheDir, `${name}.${embTag}.emb.json`);
    const embCache: Record<string, number[]> = existsSync(embPath) ? JSON.parse(readFileSync(embPath, "utf8")) : {};
    loaded.push({ name, dataset: basename(dirname(wav)), meta, ref, samples, ...stage1, embCache, embPath });
    console.log(`${name}: stage 1 ${stage1.raw.length} turns, ${new Set(stage1.raw.map((t) => t.cluster)).size} clusters (${Math.round(stage1.ms / 1000)} s)`);
  }

  type Row = FileResult & { dataset: string; pieceSec: number; stage2Ms: number; scoredMs: number };
  const cohesionRows: Array<{ file: string; cleanMs: number | null; cohesion: number | null; purity: number | null }> = [];
  const summaries = [];
  for (const combo of combos) {
    const results: Row[] = [];
    const meetingsOut: MeetingOut[] = [];
    for (const f of loaded) {
      let pieceSec = 0;
      let fresh = 0;
      const t0 = Date.now();
      const r = combo
        ? refineTurns(
            f.samples,
            f.raw,
            (x, s, e) => {
              pieceSec += x.length / RATE;
              const key = `${s}-${e}`;
              if (!f.embCache[key]) {
                f.embCache[key] = diarizer.embed(x);
                fresh++;
              }
              return f.embCache[key]!;
            },
            combo,
          )
        : { turns: f.raw, clusters: diarizer.legacyClusters(f.samples, f.raw) };
      const stage2Ms = Date.now() - t0;
      if (fresh) writeFileSync(f.embPath, JSON.stringify(f.embCache));
      const hyp: LabeledTurn[] = r.turns.map((t) => ({ speaker: `c${t.cluster}`, start: t.start, end: t.end }));
      const s = scoreDiarization(f.ref, hyp, { collarMs: 250 });
      const audioSec = f.samples.length / RATE;
      const res: Row = {
        file: f.name,
        dataset: f.dataset,
        group: f.meta.group ?? null,
        audioSec: Math.round(audioSec),
        diarizeMs: f.ms,
        rtf: f.ms / 1000 / audioSec,
        pieceSec: Math.round(pieceSec),
        stage2Ms,
        refSpeakers: s.refSpeakers,
        clusters: r.clusters.length,
        tinyClusters: r.clusters.filter((c) => c.totalMs < 5000).length,
        der: s.der,
        miss: s.missMs / s.scoredMs,
        falseAlarm: s.falseAlarmMs / s.scoredMs,
        confusion: s.confusionMs / s.scoredMs,
        splitSpeakers: s.splitSpeakers,
        mergedSpeakers: s.mergedSpeakers,
        purity: s.purity,
        coverage: s.coverage,
        scoredMs: s.scoredMs,
      };

      if (f.meta.group) {
        const turns = r.turns;
        meetingsOut.push({
          name: f.name,
          group: f.meta.group,
          clusters: r.clusters,
          dominant: s.dominant,
          cannotLink: (x: number, y: number) => longestOverlapMs(turns.filter((t) => t.cluster === x), turns.filter((t) => t.cluster === y)) >= 1000,
        });
      }
      if (combos.length === 1 && one(o, "verbose")) {
        for (const c of r.clusters) {
          const d = s.dominant.get(`c${c.cluster}`);
          cohesionRows.push({ file: f.name, cleanMs: c.cleanMs ?? null, cohesion: c.cohesion ?? null, purity: d?.share ?? null });
        }
      }
      results.push(res);
      if (combos.length === 1) {
        if (one(o, "verbose")) {
          for (const c of [...r.clusters].sort((a, b) => b.totalMs - a.totalMs)) {
            const d = s.dominant.get(`c${c.cluster}`);
            const n = r.turns.filter((t) => t.cluster === c.cluster).length;
            console.log(`   c${c.cluster}: ${(c.totalMs / 1000).toFixed(1)} s in ${n} turns, mostly ${d?.speaker ?? "-"} (${Math.round((d?.share ?? 0) * 100)} %)${c.embedding ? "" : ", no embedding"}`);
          }
        }
        console.log(
          `${f.name.padEnd(10)} ${String(res.audioSec).padStart(5)} s  ref ${res.refSpeakers}  clusters ${String(res.clusters).padStart(3)} (tiny ${res.tinyClusters})  ` +
            `DER ${(res.der * 100).toFixed(1)}%  conf ${(res.confusion * 100).toFixed(1)}%  split ${res.splitSpeakers}  merged ${res.mergedSpeakers}` +
            (res.identity ? `  id ${JSON.stringify(res.identity)}` : ""),
        );
      }
    }
    // Recognition across meetings: calibrate on series "y", report every series (x is held out).
    let recognition: Record<string, unknown> | null = null;
    if (meetingsOut.length) {
      if (!combo) recognition = { policy: "today (labelClusters, accept 0.55)", outcomes: evaluate(meetingsOut, null) };
      else {
        const base = { buckets: [10000, 30000], margin: Number(one(o, "margin", "0.05")), minSpeechMs: Number(one(o, "min-speech", "4000")), topK: 3 };
        const trials = collectTrials(meetingsOut, base.buckets, base.topK);
        const calib = trials.filter((t) => t.group === one(o, "calibrate-on", "y"));
        const policy = calibrate(calib.length ? calib : trials, base, Number(one(o, "far", "0.01")), Number(one(o, "strong-far", "0.001")));
        recognition = {
          calibratedHere: { policy, trials: trials.length, eer: equalErrorRate(trials), outcomes: evaluate(meetingsOut, policy) },
          app: { policy: MATCH_POLICY, outcomes: evaluate(meetingsOut, MATCH_POLICY) },
        };
      }
    }
    const summary = { combo, ...summarize(results), recognition, files: results };
    summaries.push(summary);
    console.log(
      `${combo ? `merge ${combo.mergeThreshold} min ${combo.minClusterMs} cl ${combo.cannotLinkMs}` : "sherpa only"}: ${JSON.stringify(summary.byDataset)}` +
        (recognition ? `
   recognition ${JSON.stringify(recognition)}` : ""),
    );
  }

  const report = {
    label: one(o, "label", "run"),
    embedding: embTag,
    threshold,
    threads,
    date: new Date().toISOString(),
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    runs: summaries,
    clusterQuality: cohesionRows,
  };
  const path = one(o, "report");
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2));
  }
  console.log(`peak RSS ${report.peakRssMb} MB`);
}

/** Speaker-time-weighted error rates and speaker-count errors, per dataset and overall. */
function summarize(rs: Array<FileResult & { dataset: string; scoredMs: number }>) {
  const agg = (xs: typeof rs) => {
    const w = xs.reduce((n, r) => n + r.scoredMs, 0) || 1;
    const pct = (k: "der" | "miss" | "falseAlarm" | "confusion") => +((xs.reduce((n, r) => n + r[k] * r.scoredMs, 0) / w) * 100).toFixed(1);
    return {
      files: xs.length,
      der: pct("der"),
      confusion: pct("confusion"),
      miss: pct("miss"),
      falseAlarm: pct("falseAlarm"),
      extraSpeakers: +(xs.reduce((n, r) => n + (r.clusters - r.refSpeakers), 0) / xs.length).toFixed(1),
      exactCount: xs.filter((r) => r.clusters === r.refSpeakers).length,
      splits: xs.reduce((n, r) => n + r.splitSpeakers, 0),
      merges: xs.reduce((n, r) => n + r.mergedSpeakers, 0),
    };
  };
  const byDataset: Record<string, ReturnType<typeof agg>> = { all: agg(rs) };
  for (const d of new Set(rs.map((r) => r.dataset))) byDataset[d] = agg(rs.filter((r) => r.dataset === d));
  const identity = { correct: 0, falseMatch: 0, missed: 0, correctUnknown: 0, noEmbedding: 0 };
  for (const r of rs) if (r.identity) for (const k of Object.keys(identity) as Array<keyof typeof identity>) identity[k] += r.identity[k];
  return { byDataset, identity };
}

/**
 * How well each embedding model separates people: same-vs-different-speaker EER on fixed-length
 * crops, with plain cosine and with cosine after subtracting the set's mean embedding.
 *   embed-bench --model a.onnx [--model b.onnx] --libri <dev-clean-2> --ami <dir with *.wav+*.rttm>
 */
async function embedBench(o: Map<string, string[]>): Promise<void> {
  type Item = { set: string; spk: string; x: Float32Array };
  const crops: Item[] = [];
  const secs = [1, 3];
  const libri = indexLibriSpeech(one(o, "libri")!);
  for (const sp of libri) {
    for (const f of sp.files.slice(0, 4)) {
      const x = await decodeFile(f);
      for (const s of secs) if (x.length > (s + 0.5) * RATE) crops.push({ set: `libri-${s}s`, spk: sp.id, x: x.slice(RATE * 0.5, RATE * (0.5 + s)) });
    }
  }
  const amiDir = one(o, "ami");
  if (amiDir) {
    for (const f of readdirSync(amiDir).filter((n) => n.endsWith(".wav"))) {
      const name = basename(f, ".wav");
      const a = await decodeFile(join(amiDir, f));
      const turns = parseRttm(readFileSync(join(amiDir, `${name}.rttm`), "utf8")).get(name) ?? [];
      const iso = turns.filter((t) => t.end - t.start >= 3200 && !turns.some((u) => u !== t && u.start < t.end && u.end > t.start));
      for (const t of iso) {
        const at = Math.floor(((t.start + 100) / 1000) * RATE);
        for (const s of secs) crops.push({ set: `ami-${s}s`, spk: `${name}:${t.speaker}`, x: a.slice(at, at + s * RATE) });
      }
    }
  }
  for (const model of o.get("model") ?? []) {
    const d = createDiarizer(sherpa, { segmentation: "", embedding: model, threads: Math.max(2, Math.min(8, cpus().length - 2)) });
    const t0 = Date.now();
    const embs = crops.map((c) => Float64Array.from(d.embed(c.x)));
    const audioSec = crops.reduce((n, c) => n + c.x.length / RATE, 0);
    const rtf = (Date.now() - t0) / 1000 / audioSec;
    const rows: string[] = [];
    for (const set of [...new Set(crops.map((c) => c.set))]) {
      const idx = crops.map((c, i) => (c.set === set ? i : -1)).filter((i) => i >= 0);
      const dim = embs[0]!.length;
      const mean = new Float64Array(dim);
      for (const i of idx) for (let k = 0; k < dim; k++) mean[k]! += embs[i]![k]! / idx.length;
      const centred = (v: Float64Array) => v.map((x, k) => x - mean[k]!);
      const raw: Trial[] = [];
      const cen: Trial[] = [];
      for (let a = 0; a < idx.length; a++) {
        for (let b = a + 1; b < idx.length; b++) {
          const same = crops[idx[a]!]!.spk === crops[idx[b]!]!.spk;
          raw.push({ score: cosine(embs[idx[a]!]!, embs[idx[b]!]!), same });
          cen.push({ score: cosine(centred(embs[idx[a]!]!), centred(embs[idx[b]!]!)), same });
        }
      }
      const norm = Math.hypot(...mean) / (idx.reduce((n, i) => n + Math.hypot(...embs[i]!), 0) / idx.length);
      rows.push(
        `${set.padEnd(9)} n=${String(idx.length).padStart(3)}  |mean|/|emb| ${norm.toFixed(2)}  EER raw ${(equalErrorRate(raw).eer * 100).toFixed(1).padStart(5)}% @${equalErrorRate(raw).threshold.toFixed(2)}  centred ${(equalErrorRate(cen).eer * 100).toFixed(1).padStart(5)}%`,
      );
    }
    console.log(`\n${basename(model)}  (dim ${embs[0]!.length}, RTF ${rtf.toFixed(4)})\n  ${rows.join("\n  ")}`);
  }
}

/**
 * Recognition thresholds per amount of speech. Each speaker's speech is split in two: the first
 * part builds a profile like the app's (up to 3 voiceprints of ~30 s each), the held-out part
 * gives probes of about 6, 20 and 45 s of clear speech (one per speech bucket). Probes are scored
 * against every profile in the same set; thresholds are picked at the target false-accept rate.
 *   calibrate --model <onnx> --libri <dev-clean-2> --ami <dir> [--far 0.01] [--strong-far 0.001]
 */
async function calibrateBuckets(o: Map<string, string[]>): Promise<void> {
  const model = one(o, "model")!;
  const d = createDiarizer(sherpa, { segmentation: "", embedding: model, threads: Math.max(2, Math.min(8, cpus().length - 2)) });
  // Speech per speaker as a list of clean stretches (sample arrays), per set.
  const sets = new Map<string, Map<string, Float32Array[]>>();
  const add = (set: string, spk: string, x: Float32Array) => {
    const m = sets.get(set) ?? new Map<string, Float32Array[]>();
    sets.set(set, m);
    m.set(spk, [...(m.get(spk) ?? []), x]);
  };
  for (const sp of indexLibriSpeech(one(o, "libri")!)) {
    for (const f of sp.files) {
      const x = await decodeFile(f);
      for (const [a, b] of speechRegionsOf(x)) add("libri", sp.id, x.slice(a, b));
    }
  }
  const amiDir = one(o, "ami");
  if (amiDir) {
    for (const f of readdirSync(amiDir).filter((n) => n.endsWith(".wav"))) {
      const name = basename(f, ".wav");
      const a = await decodeFile(join(amiDir, f));
      const turns = parseRttm(readFileSync(join(amiDir, `${name}.rttm`), "utf8")).get(name) ?? [];
      for (const t of turns) {
        if (t.end - t.start < 1500 || turns.some((u) => u !== t && u.start < t.end && u.end > t.start)) continue;
        add("ami", `${name}:${t.speaker}`, a.slice(Math.floor(((t.start + 100) / 1000) * RATE), Math.floor(((t.end - 100) / 1000) * RATE)));
      }
    }
  }
  // Cut stretches into 3–6 s pieces and embed them.
  const pieces = (xs: Float32Array[]) => xs.flatMap((x) => {
    const out: Float32Array[] = [];
    for (let i = 0; i + RATE * 1.5 <= x.length; i += RATE * 5) out.push(x.subarray(i, Math.min(x.length, i + RATE * 5)));
    return out;
  });
  const centroid = (es: Array<{ e: number[]; ms: number }>) => {
    const acc = new Array<number>(es[0]!.e.length).fill(0);
    for (const { e, ms } of es) {
      const n = Math.hypot(...e) || 1;
      for (let k = 0; k < acc.length; k++) acc[k]! += (e[k]! / n) * ms;
    }
    return acc;
  };
  const targets = [6000, 20000, 45000];
  const trials = targets.map(() => [] as Trial[]);
  for (const [set, speakers] of sets) {
    const profiles: KnownVoice[] = [];
    const probes: Array<{ spk: string; bucket: number; e: number[] }> = [];
    for (const [spk, xs] of speakers) {
      const ps = pieces(xs).map((x) => ({ e: d.embed(x), ms: (x.length / RATE) * 1000 }));
      const total = ps.reduce((n, p) => n + p.ms, 0);
      if (total < Number(one(o, "min-total", "60000"))) continue; // too little speech to split into profile + probes
      // First ~45 % builds the profile (up to 3 samples of ~30 s), the rest are probes.
      const cut = ps.findIndex((_, i) => ps.slice(0, i + 1).reduce((n, p) => n + p.ms, 0) >= total * 0.45);
      const enrol = ps.slice(0, cut + 1);
      const held = ps.slice(cut + 1);
      const samples: number[][] = [];
      for (let i = 0; i < enrol.length && samples.length < 3; ) {
        const group: typeof enrol = [];
        let ms = 0;
        while (i < enrol.length && ms < 30000) {
          group.push(enrol[i]!);
          ms += enrol[i++]!.ms;
        }
        if (ms >= 10000) samples.push(centroid(group));
      }
      if (!samples.length) continue;
      profiles.push({ personId: spk, name: spk, embeddings: samples, qualities: samples.map(() => 0.8) });
      targets.forEach((target, bucket) => {
        for (let i = 0; i < held.length; ) {
          const group: typeof held = [];
          let ms = 0;
          while (i < held.length && ms < target) {
            group.push(held[i]!);
            ms += held[i++]!.ms;
          }
          if (ms >= target * 0.8) probes.push({ spk, bucket, e: centroid(group) });
        }
      });
    }
    const own = targets.map(() => [] as Trial[]);
    for (const p of probes) for (const v of profiles) {
      const t = { score: profileScore(p.e, v, 3), same: v.personId === p.spk };
      trials[p.bucket]!.push(t);
      own[p.bucket]!.push(t);
    }
    console.log(`${set}: ${profiles.length} speakers with profiles, ${probes.length} probes; per bucket accept@FAR ` + own.map((tr) => (tr.length ? `${thresholdForFar(tr, Number(one(o, "far", "0.01"))).toFixed(3)} (EER ${(equalErrorRate(tr).eer * 100).toFixed(1)}%, max impostor ${Math.max(...tr.filter((x) => !x.same).map((x) => x.score)).toFixed(3)})` : "-")).join(" | "));
  }
  const far = Number(one(o, "far", "0.01"));
  const strongFar = Number(one(o, "strong-far", "0.001"));
  const out = targets.map((t, b) => {
    const tr = trials[b]!;
    return {
      probeMs: t,
      same: tr.filter((x) => x.same).length,
      different: tr.filter((x) => !x.same).length,
      eer: +(equalErrorRate(tr).eer * 100).toFixed(2),
      accept: +thresholdForFar(tr, far).toFixed(3),
      strong: +thresholdForFar(tr, strongFar).toFixed(3),
      frrAtAccept: +(ratesAt(tr, thresholdForFar(tr, far)).frr * 100).toFixed(1),
    };
  });
  console.log(JSON.stringify(out, null, 1));
  const check = one(o, "check")?.split(",").map(Number);
  if (check) {
    check.forEach((th, b) => {
      const r = ratesAt(trials[b]!, th);
      console.log(`bucket ${b} (~${targets[b]! / 1000} s) at ${th}: false accept ${(r.far * 100).toFixed(2)}%, false reject ${(r.frr * 100).toFixed(2)}%`);
    });
  }
  const path = one(o, "report");
  if (path) writeFileSync(path, JSON.stringify({ model: basename(model), far, strongFar, buckets: out, check: check ?? null }, null, 2));
}

function speechRegionsOf(x: Float32Array): Array<[number, number]> {
  return speechRegions(x, { relDb: -35, bridgeMs: 300 }).filter(([a, b]) => b - a >= RATE * 1.5);
}

const { cmd, opt } = args();
const jobs: Record<string, (o: Map<string, string[]>) => Promise<void>> = { synth, run: runEval, "embed-bench": embedBench, calibrate: calibrateBuckets };
if (!jobs[cmd]) {
  console.error("usage: speaker-eval synth|run ...");
  process.exit(2);
}
jobs[cmd](opt).catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
