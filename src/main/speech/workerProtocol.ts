export type WorkerRequest =
  | { type: "init"; parakeetDir: string; vadModel: string; threads: number }
  | { type: "begin"; id: string }
  | { type: "audio"; id: string; samples: Float32Array }
  | { type: "end"; id: string }
  | { type: "abort"; id: string }
  | { type: "transcribe"; id: string; samples: Float32Array };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "log"; message: string }
  | { type: "final"; id: string; text: string; decodeMs: number; audioMs: number }
  | { type: "error"; id?: string; message: string };
