import type { Channel, Segment, Turn } from "@shared/meeting/types";

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
  | { type: "diarize"; id: string; path: string; numSpeakers?: number; threshold?: number }
  | { type: "embed"; id: string; samples: Float32Array };

export interface ClusterInfo {
  cluster: number;
  embedding: number[] | null;
  firstStart: number;
  totalMs: number;
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
  | { type: "progress"; id: string; done: number; total: number }
  | { type: "error"; id?: string; message: string };
