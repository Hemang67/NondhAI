/**
 * Cross-meeting recognition, simulated over a series of meetings with known speakers: after each
 * meeting the user names every speaker (the cluster's dominant true voice), which saves a
 * voiceprint under the app's rules; later meetings are scored on who they recognise.
 */
import { identify, profileScore, voiceQuality, type KnownVoice, type MatchPolicy } from "@shared/meeting/speakers";
import { labelClusters } from "./legacy";
import { thresholdForFar, type Trial } from "@shared/meeting/eval/identity";
import type { ClusterInfo } from "../../src/main/speech/workerProtocol";

export interface MeetingOut {
  name: string;
  group: string;
  clusters: ClusterInfo[];
  dominant: Map<string, { speaker: string; share: number }>;
  cannotLink: (a: number, b: number) => boolean;
}

export interface Outcomes {
  correct: number;
  falseMatch: number;
  missed: number;
  correctUnknown: number;
  /** Clusters with too little speech to judge (never named by design). */
  tooShort: number;
}

const none = (): Outcomes => ({ correct: 0, falseMatch: 0, missed: 0, correctUnknown: 0, tooShort: 0 });

type Store = Map<string, { e: number[][]; q: number[] }>;

/** Save a named cluster's voice the way the app does (new rules unless `legacy`). */
function enroll(store: Store, m: MeetingOut, legacy: boolean): void {
  for (const c of m.clusters) {
    const d = m.dominant.get(`c${c.cluster}`);
    if (!c.embedding || !d) continue;
    const q = legacy ? 0.5 : voiceQuality(c.cleanMs ?? 0, c.cohesion ?? 0);
    if (!legacy && q <= 0) continue;
    const cur = store.get(d.speaker) ?? { e: [], q: [] };
    const all = [...cur.e.map((e, i) => ({ e, q: cur.q[i]!, at: i })), { e: c.embedding, q, at: cur.e.length }];
    const keep = legacy ? all.slice(-8) : all.sort((a, b) => b.q - a.q || b.at - a.at).slice(0, 8);
    store.set(d.speaker, { e: keep.map((x) => x.e), q: keep.map((x) => x.q) });
  }
}

const voicesOf = (store: Store): KnownVoice[] => [...store].map(([id, v]) => ({ personId: id, name: id, embeddings: v.e, qualities: v.q }));

/** Same-vs-different trials (cluster voice vs a person's profile), by speech bucket. */
export function collectTrials(meetings: MeetingOut[], buckets: number[], topK: number): Array<Trial & { bucket: number; group: string }> {
  const out: Array<Trial & { bucket: number; group: string }> = [];
  const stores = new Map<string, Store>();
  for (const m of meetings) {
    const store = stores.get(m.group) ?? new Map();
    stores.set(m.group, store);
    for (const c of m.clusters) {
      const truth = m.dominant.get(`c${c.cluster}`)?.speaker;
      if (!c.embedding || !truth) continue;
      const bucket = buckets.findIndex((b) => (c.cleanMs ?? 0) < b);
      for (const v of voicesOf(store)) out.push({ score: profileScore(c.embedding, v, topK), same: v.personId === truth, bucket: bucket < 0 ? buckets.length : bucket, group: m.group });
    }
    enroll(store, m, false);
  }
  return out;
}

/**
 * Accept thresholds per bucket at the target false-accept rate; a bucket with too few impostor
 * trials borrows the strictest of its longer-speech neighbours, so short clusters are never
 * judged more leniently than long ones.
 */
export function calibrate(trials: Array<Trial & { bucket: number }>, base: Omit<MatchPolicy, "accept" | "strong">, targetFar: number, strongFar: number): MatchPolicy {
  const n = base.buckets.length + 1;
  const accept: number[] = [];
  const strong: number[] = [];
  const all = trials;
  for (let b = 0; b < n; b++) {
    const t = trials.filter((x) => x.bucket === b);
    const enough = t.filter((x) => !x.same).length >= 50;
    const src = enough ? t : all;
    accept.push(thresholdForFar(src, targetFar));
    strong.push(thresholdForFar(src, strongFar));
  }
  for (let b = n - 2; b >= 0; b--) {
    accept[b] = Math.max(accept[b]!, accept[b + 1]!);
    strong[b] = Math.max(strong[b]!, strong[b + 1]!);
  }
  return { ...base, accept: accept.map((x) => +x.toFixed(3)), strong: strong.map((x) => +x.toFixed(3)) };
}

/** Recognition outcomes per group: today's labelClusters (`policy` null) or identify(policy). */
export function evaluate(meetings: MeetingOut[], policy: MatchPolicy | null): Record<string, Outcomes> {
  const res: Record<string, Outcomes> = {};
  const stores = new Map<string, Store>();
  for (const m of meetings) {
    const store = stores.get(m.group) ?? new Map();
    stores.set(m.group, store);
    const o = (res[m.group] ??= none());
    const voices = voicesOf(store);
    const named = new Map<number, string | null>();
    if (policy) {
      const r = identify(
        m.clusters.map((c) => ({ ...c, cleanMs: c.cleanMs ?? 0 })),
        voices,
        policy,
        m.cannotLink,
      );
      for (const c of m.clusters) named.set(c.cluster, r.labels.get(c.cluster)?.personId ?? null);
    } else {
      const labels = labelClusters(m.clusters, voices);
      for (const c of m.clusters) named.set(c.cluster, labels.get(c.cluster)?.personId ?? null);
    }
    for (const c of m.clusters) {
      const truth = m.dominant.get(`c${c.cluster}`)?.speaker;
      if (!truth) continue;
      const who = named.get(c.cluster);
      if (who) who === truth ? o.correct++ : o.falseMatch++;
      else if (policy && (!c.embedding || (c.cleanMs ?? 0) < policy.minSpeechMs)) o.tooShort++;
      else store.has(truth) ? o.missed++ : o.correctUnknown++;
    }
    enroll(store, m, !policy);
  }
  return res;
}
