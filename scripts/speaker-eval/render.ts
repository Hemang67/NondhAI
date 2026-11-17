import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { toRttm, type LabeledTurn } from "@shared/meeting/eval/diarization";
import { RATE, decodeFile, filter, opusRoundTrip, speechRegions, writeWav } from "./audio";
import { mulberry32, planConversation } from "./plan";

/** How one participant's microphone and line sound. */
export type Condition = "clean" | "tele" | "noisy" | "reverb" | "laptop" | "lowbitrate";

export interface Scenario {
  name: string;
  /** Meetings in one group share people; identification is scored across them in order. */
  group?: string;
  seed: number;
  minutes: number;
  ackRate: number;
  longRate: number;
  overlapRate: number;
  /** Participant → condition. Participants are pool indexes, so groups can reuse people. */
  people: Array<{ person: number; condition: Condition }>;
  /** Each turn randomly narrowband or wideband (conferencing codecs switching bandwidth). */
  switchBandwidth?: boolean;
}

const CONDITIONS: Condition[] = ["clean", "tele", "noisy", "reverb", "laptop", "lowbitrate"];
const ppl = (n: number, cond: (i: number) => Condition, offset = 0) => Array.from({ length: n }, (_, i) => ({ person: offset + i, condition: cond(i) }));

/**
 * The synthetic part of the evaluation set. Person indexes wrap around the speaker pool, so they
 * are distinct within a meeting and within the "x" group; separate meetings may reuse voices.
 */
export const SUITE: Scenario[] = [
  { name: "p2-clean", seed: 1, minutes: 6, ackRate: 0.15, longRate: 0.1, overlapRate: 0.1, people: ppl(2, () => "clean", 0) },
  { name: "p5-mixed", seed: 2, minutes: 10, ackRate: 0.15, longRate: 0.1, overlapRate: 0.1, people: ppl(5, (i) => CONDITIONS[i % 3]!, 2) },
  { name: "p10-mixed", seed: 3, minutes: 15, ackRate: 0.15, longRate: 0.05, overlapRate: 0.1, people: ppl(10, (i) => CONDITIONS[i % 3]!, 7) },
  { name: "acks", seed: 4, minutes: 8, ackRate: 0.35, longRate: 0.05, overlapRate: 0.1, people: ppl(4, () => "clean", 17) },
  { name: "long", seed: 5, minutes: 10, ackRate: 0.1, longRate: 0.5, overlapRate: 0.05, people: ppl(3, () => "clean", 21) },
  { name: "overlap", seed: 6, minutes: 8, ackRate: 0.15, longRate: 0.1, overlapRate: 0.35, people: ppl(4, () => "clean", 24) },
  { name: "mics", seed: 7, minutes: 10, ackRate: 0.15, longRate: 0.1, overlapRate: 0.1, people: ppl(6, (i) => CONDITIONS[i]!, 28) },
  { name: "bwswitch", seed: 8, minutes: 8, ackRate: 0.15, longRate: 0.1, overlapRate: 0.1, people: ppl(4, () => "clean", 34), switchBandwidth: true },
  // The same people across three meetings, on different microphones each time.
  {
    name: "x1", group: "x", seed: 9, minutes: 8, ackRate: 0.15, longRate: 0.1, overlapRate: 0.1,
    people: [0, 1, 2, 3].map((i) => ({ person: 38 + i, condition: "clean" as Condition })),
  },
  {
    name: "x2", group: "x", seed: 10, minutes: 8, ackRate: 0.15, longRate: 0.1, overlapRate: 0.1,
    people: [
      { person: 38, condition: "tele" },
      { person: 39, condition: "noisy" },
      { person: 42, condition: "clean" },
      { person: 43, condition: "laptop" },
    ],
  },
  {
    name: "x3", group: "x", seed: 11, minutes: 8, ackRate: 0.15, longRate: 0.1, overlapRate: 0.1,
    people: [
      { person: 40, condition: "reverb" },
      { person: 41, condition: "lowbitrate" },
      { person: 42, condition: "tele" },
      { person: 38, condition: "laptop" },
    ],
  },
  // A longer series for calibrating recognition: ten people, five per meeting, returning on
  // different microphones, with newcomers who must stay unknown.
  ...[
    [0, 1, 2, 3, 4],
    [0, 1, 5, 6, 7],
    [2, 3, 5, 8, 9],
    [0, 4, 6, 8, 1],
    [1, 2, 7, 9, 3],
    [0, 5, 8, 4, 6],
  ].map((who, m): Scenario => ({
    name: `y${m + 1}`,
    group: "y",
    seed: 20 + m,
    minutes: 6,
    ackRate: 0.15,
    longRate: 0.1,
    overlapRate: 0.1,
    people: who.map((p, i) => ({ person: 44 + p, condition: CONDITIONS[(p + m + i) % CONDITIONS.length]! })),
  })),
];

export interface LibriSpeaker {
  id: string;
  sex: string;
  files: string[];
}

export function indexLibriSpeech(root: string): LibriSpeaker[] {
  // root = .../LibriSpeech/dev-clean-2; SPEAKERS.TXT sits one level up.
  const sexes = new Map<string, string>();
  const meta = join(root, "..", "SPEAKERS.TXT");
  if (existsSync(meta)) {
    for (const line of readFileSync(meta, "utf8").split(/\r?\n/)) {
      const f = line.split("|").map((x) => x.trim());
      if (/^\d+$/.test(f[0] ?? "")) sexes.set(f[0]!, f[1] ?? "?");
    }
  }
  return readdirSync(root)
    .filter((d) => /^\d+$/.test(d))
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => ({
      id,
      sex: sexes.get(id) ?? "?",
      files: readdirSync(join(root, id))
        .flatMap((ch) => readdirSync(join(root, id, ch)).filter((f) => f.endsWith(".flac")).map((f) => join(root, id, ch, f)))
        .sort(),
    }));
}

const CHAIN: Record<Condition, string | null> = {
  clean: null,
  tele: "highpass=f=300,lowpass=f=3400",
  noisy: null, // noise is added in JS (seeded)
  reverb: "aecho=0.8:0.6:30|70|110:0.35|0.25|0.15",
  laptop: "highpass=f=200,lowpass=f=2800,acompressor=threshold=0.1:ratio=4",
  lowbitrate: null, // Opus 12 kbps round trip
};

function rms(x: Float32Array): number {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i]! * x[i]!;
  return Math.sqrt(e / Math.max(1, x.length));
}

/** A speaker's speech, silence-trimmed and concatenated, at a given level and condition. */
async function speakerSource(sp: LibriSpeaker, condition: Condition, levelDb: number, seed: number): Promise<Float32Array> {
  const pieces: Float32Array[] = [];
  for (const f of sp.files) {
    const x = await decodeFile(f);
    const r = speechRegions(x, { relDb: -40, bridgeMs: 1000 });
    if (!r.length) continue;
    pieces.push(x.subarray(Math.max(0, r[0]![0] - 1600), Math.min(x.length, r.at(-1)![1] + 1600)));
  }
  let src: Float32Array = new Float32Array(pieces.reduce((n, p) => n + p.length + 3200, 0));
  let off = 0;
  for (const p of pieces) {
    src.set(p, off);
    off += p.length + 3200;
  }
  const gain = Math.pow(10, levelDb / 20) / (rms(src) || 1);
  for (let i = 0; i < src.length; i++) src[i]! *= gain;
  const chain = CHAIN[condition];
  if (chain) src = await filter(src, chain);
  if (condition === "lowbitrate") src = await opusRoundTrip(src, "12k");
  if (condition === "noisy") {
    const rnd = mulberry32(seed);
    const amp = Math.pow(10, (levelDb - 15) / 20) * Math.sqrt(3); // ~15 dB SNR, uniform noise
    for (let i = 0; i < src.length; i++) src[i]! += amp * (rnd() * 2 - 1);
  }
  return src;
}

/** Cut at the quietest 10 ms within ±400 ms of `at`, so turns rarely end mid-word. */
function quietCut(x: Float32Array, at: number): number {
  const w = 160;
  let best = at;
  let bestE = Infinity;
  for (let c = Math.max(w, at - 6400); c < Math.min(x.length - w, at + 6400); c += w) {
    let e = 0;
    for (let i = c - w; i < c; i++) e += x[i]! * x[i]!;
    if (e < bestE) {
      bestE = e;
      best = c;
    }
  }
  return best;
}

export async function renderScenario(sc: Scenario, pool: LibriSpeaker[], outDir: string): Promise<{ wav: string; seconds: number }> {
  mkdirSync(outDir, { recursive: true });
  const rnd = mulberry32(sc.seed * 7919);
  const who = (person: number) => pool[person % pool.length]!;
  const label = (person: number) => `ls${who(person).id}`;
  const plan = planConversation({
    seed: sc.seed,
    speakers: sc.people.map((p) => label(p.person)),
    durationMs: sc.minutes * 60000,
    ackRate: sc.ackRate,
    longRate: sc.longRate,
    overlapRate: sc.overlapRate,
  });
  const src = new Map<string, Float32Array>();
  const narrow = new Map<string, Float32Array>();
  for (const p of sc.people) {
    const level = -30 + rnd() * 10;
    src.set(label(p.person), await speakerSource(who(p.person), p.condition, level, sc.seed * 31 + p.person));
    if (sc.switchBandwidth) narrow.set(label(p.person), await speakerSource(who(p.person), "tele", level, 0));
  }
  const regions = new Map([...src].map(([k, x]) => [k, speechRegions(x, { relDb: -35, bridgeMs: 300 }).filter(([a, b]) => b - a > 4800)]));
  const cursor = new Map<string, number>();

  const endMs = Math.max(...plan.map((t) => t.start + t.durMs)) + 1000;
  const mix = new Float32Array(Math.ceil((endMs / 1000) * RATE));
  const ref: LabeledTurn[] = [];
  for (const turn of plan) {
    const full = sc.switchBandwidth && rnd() < 0.5 ? narrow.get(turn.speaker)! : src.get(turn.speaker)!;
    const len = Math.round((turn.durMs / 1000) * RATE);
    let piece: Float32Array;
    if (turn.kind === "ack") {
      // A short burst from the start of some stretch of this person's speech.
      const rs = regions.get(turn.speaker)!;
      const [a] = rs[Math.floor(rnd() * rs.length)]!;
      piece = full.subarray(a, Math.min(full.length, a + len));
    } else {
      let from = cursor.get(turn.speaker) ?? Math.floor(rnd() * full.length * 0.5);
      if (from + len + 6400 >= full.length) from = 0;
      const to = quietCut(full, from + len);
      piece = full.subarray(from, to);
      cursor.set(turn.speaker, to);
    }
    const at = Math.round((turn.start / 1000) * RATE);
    for (let i = 0; i < piece.length && at + i < mix.length; i++) mix[at + i]! += piece[i]!;
    for (const [a, b] of speechRegions(piece, { relDb: -30, bridgeMs: 400 })) {
      ref.push({ speaker: turn.speaker, start: Math.round(((at + a) / RATE) * 1000), end: Math.round(((at + b) / RATE) * 1000) });
    }
  }
  let peak = 0;
  for (let i = 0; i < mix.length; i++) peak = Math.max(peak, Math.abs(mix[i]!));
  if (peak > 0.95) for (let i = 0; i < mix.length; i++) mix[i]! *= 0.95 / peak;
  // Remote voices arrive through a conferencing codec.
  const out = await opusRoundTrip(mix, "24k");

  const wav = join(outDir, `${sc.name}.wav`);
  writeWav(wav, out);
  writeFileSync(join(outDir, `${sc.name}.rttm`), toRttm(sc.name, ref.sort((a, b) => a.start - b.start)));
  writeFileSync(
    join(outDir, `${sc.name}.json`),
    JSON.stringify(
      {
        name: sc.name,
        group: sc.group ?? null,
        speakers: sc.people.map((p) => ({ label: label(p.person), sex: who(p.person).sex, condition: p.condition })),
        turns: { total: plan.length, acks: plan.filter((t) => t.kind === "ack").length, long: plan.filter((t) => t.kind === "long").length },
        switchBandwidth: !!sc.switchBandwidth,
      },
      null,
      2,
    ),
  );
  return { wav, seconds: out.length / RATE };
}
