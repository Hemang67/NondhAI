import type { Turn } from "@shared/meeting/types";
import { planPieces, recluster, type PieceOptions, type RawTurn, type ReclusterOptions } from "@shared/meeting/refine";
import type { ClusterInfo } from "./workerProtocol";

const SAMPLE_RATE = 16000;

export interface DiarizerConfig {
  segmentation: string;
  embedding: string;
  threads: number;
}

export interface DiarizeOptions {
  numSpeakers?: number;
  /** sherpa's clustering threshold (cosine distance, complete linkage). */
  threshold?: number;
  /** Meeting-level re-clustering of sherpa's output; false = sherpa's clusters as they are. */
  refine?: (PieceOptions & ReclusterOptions) | false;
}

export interface Diarizer {
  diarize(samples: Float32Array, opts?: DiarizeOptions): { turns: Turn[]; clusters: ClusterInfo[] };
  /** Stage 1 only: sherpa's who-spoke-when. */
  segment(samples: Float32Array, opts?: Pick<DiarizeOptions, "numSpeakers" | "threshold">): RawTurn[];
  embed(samples: Float32Array): number[];
  /** The original per-cluster embedding (longest turns concatenated), for comparison. */
  legacyClusters(samples: Float32Array, turns: Turn[]): ClusterInfo[];
}

const slice = (samples: Float32Array, startMs: number, endMs: number) =>
  samples.subarray(Math.floor((startMs / 1000) * SAMPLE_RATE), Math.floor((endMs / 1000) * SAMPLE_RATE));

/**
 * Stage 2: embed clean pieces of sherpa's clusters and re-cluster them for the whole meeting
 * (src/shared/meeting/refine.ts). `embed` is injected so the evaluation can cache embeddings.
 */
export function refineTurns(
  samples: Float32Array,
  raw: RawTurn[],
  embed: (samples: Float32Array, startMs: number, endMs: number) => ArrayLike<number>,
  opts: PieceOptions & ReclusterOptions = {},
): { turns: Turn[]; clusters: ClusterInfo[] } {
  const pieces = planPieces(raw, opts).map((p) => ({ ...p, embedding: embed(slice(samples, p.start, p.end), p.start, p.end) }));
  const r = recluster(raw, pieces, opts);
  return {
    turns: r.turns,
    clusters: r.clusters.map((c) => ({ cluster: c.cluster, embedding: c.embedding, firstStart: c.firstStart, totalMs: c.totalMs, cleanMs: c.cleanMs, cohesion: c.cohesion })),
  };
}

/**
 * Who-spoke-when for one track (pyannote segmentation + speaker embeddings via sherpa-onnx), plus
 * each speaker's voice embedding. Shared by the speech worker and the speaker evaluation harness,
 * so both measure the same code. `sherpa` is the sherpa-onnx-node module.
 */
export function createDiarizer(sherpa: any, cfg: DiarizerConfig): Diarizer {
  let extractor: any = null;
  const embed = (samples: Float32Array): number[] => {
    extractor ??= new sherpa.SpeakerEmbeddingExtractor({ model: cfg.embedding, numThreads: cfg.threads, debug: 0 });
    const s = extractor.createStream();
    s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    s.inputFinished();
    return Array.from(extractor.compute(s, false) as Float32Array);
  };

  const segment: Diarizer["segment"] = (samples, opts = {}) => {
    const sd = new sherpa.OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: cfg.segmentation }, numThreads: cfg.threads, debug: 0 },
      embedding: { model: cfg.embedding, numThreads: cfg.threads, debug: 0 },
      clustering: { numClusters: opts.numSpeakers ?? -1, threshold: opts.threshold ?? 0.6 },
      minDurationOn: 0.3,
      minDurationOff: 0.5,
    });
    const raw = sd.process(samples) as Array<{ start: number; end: number; speaker: number }>;
    return raw.map((t) => ({ start: Math.round(t.start * 1000), end: Math.round(t.end * 1000), cluster: t.speaker }));
  };

  /** The original per-cluster embedding: longest turns (≥ 800 ms, ~60 s) concatenated. */
  const legacyClusters = (samples: Float32Array, turns: Turn[]): ClusterInfo[] => {
    const byCluster = new Map<number, Turn[]>();
    for (const t of turns) {
      if (!byCluster.has(t.cluster)) byCluster.set(t.cluster, []);
      byCluster.get(t.cluster)!.push(t);
    }
    const clusters: ClusterInfo[] = [];
    for (const [cluster, ts] of byCluster) {
      const longest = [...ts].sort((a, b) => b.end - b.start - (a.end - a.start));
      const picked: Float32Array[] = [];
      let total = 0;
      for (const t of longest) {
        if (t.end - t.start < 800 || total > 60000) continue;
        picked.push(slice(samples, t.start, t.end));
        total += t.end - t.start;
      }
      let embedding: number[] | null = null;
      if (picked.length) {
        const joined = new Float32Array(picked.reduce((n, p) => n + p.length, 0));
        let off = 0;
        for (const p of picked) {
          joined.set(p, off);
          off += p.length;
        }
        embedding = embed(joined);
      }
      clusters.push({ cluster, embedding, firstStart: Math.min(...ts.map((t) => t.start)), totalMs: ts.reduce((n, t) => n + t.end - t.start, 0) });
    }
    return clusters;
  };

  const diarize: Diarizer["diarize"] = (samples, opts = {}) => {
    const raw = segment(samples, opts);
    if (opts.refine === false || opts.refine === undefined) return { turns: raw, clusters: legacyClusters(samples, raw) };
    return refineTurns(samples, raw, (x) => embed(x), opts.refine);
  };

  return { diarize, segment, embed, legacyClusters };
}
