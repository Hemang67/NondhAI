import type { Channel, Segment, Turn } from "@shared/meeting/types";
import type { PieceOptions, ReclusterOptions } from "@shared/meeting/refine";

export interface DiarizationModels {
  segmentation: string;
  embedding: string;
}

export type WorkerRequest =
  | { type: "init"; parakeetDir: string; vadModel: string; threads: number; diarization?: DiarizationModels }
  // dictation
  | { type: "begin"; id: string }
  | { type: "audio"; id: string; samples: Float32Array }
  | { type: "end"; id: string }
  | { type: "abort"; id: string }
  | { type: "transcribe"; id: string; samples: Float32Array }
  // meetings: live, timestamped, one stream per channel
  | { type: "stream-begin"; id: string; channel: Channel; offsetMs: number }
  | { type: "stream-audio"; id: string; samples: Float32Array }
  | { type: "stream-end"; id: string }
  // meetings: after the call
  | { type: "final-pass"; id: string; path: string; channel: Channel }
  | { type: "diarize"; id: string; path: string; numSpeakers?: number; threshold?: number; refine?: (PieceOptions & ReclusterOptions) | false }
  /** speechOnly: drop silence first (voice enrollment), since silence shifts the embedding. */
  | { type: "embed"; id: string; samples: Float32Array; speechOnly?: boolean }
  /** Embed stretches (ms) of a 16 kHz PCM track, e.g. to rebuild a named person's voice. */
  | { type: "embed-ranges"; id: string; path: string; ranges: Array<[number, number]> };

export interface ClusterInfo {
  cluster: number;
  embedding: number[] | null;
  firstStart: number;
  totalMs: number;
  /** Speech behind the embedding (ms); absent for the legacy embedding. */
  cleanMs?: number;
  /** Mean similarity of the cluster's pieces to its embedding (0..1). */
  cohesion?: number;
}

export type WorkerResponse =
  | { type: "ready" }
  | { type: "log"; message: string }
  | { type: "final"; id: string; text: string; decodeMs: number; audioMs: number }
  | { type: "segment"; id: string; segment: Segment }
  | { type: "stream-done"; id: string }
  | { type: "segments"; id: string; segments: Segment[]; ms: number }
  | { type: "diarized"; id: string; turns: Turn[]; clusters: ClusterInfo[]; ms: number }
  | { type: "embedding"; id: string; embedding: number[] }
  | { type: "embeddings"; id: string; embeddings: number[][] }
  | { type: "progress"; id: string; done: number; total: number }
  | { type: "error"; id?: string; message: string };
