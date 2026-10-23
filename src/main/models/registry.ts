import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ModelDef {
  id: string;
  engine: "parakeet" | "whisper" | "llm" | "vad";
  name: string;
  sizeMb: number;
  description: string;
  url: string;
  /** Archive downloads extract into this folder name; plain files are saved as `file`. */
  archiveDir?: string;
  file?: string;
}

const HF_WHISPER = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const SHERPA = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export const MODELS: ModelDef[] = [
  {
    id: "parakeet-unified-en-0.6b",
    engine: "parakeet",
    name: "Parakeet Unified EN 0.6B",
    sizeMb: 631,
    description: "English. Best accuracy and speed on CPU. Recommended for dictation.",
    url: `${SHERPA}/asr-models/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming.tar.bz2`,
    archiveDir: "sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming",
  },
  {
    id: "parakeet-tdt-0.6b-v3",
    engine: "parakeet",
    name: "Parakeet TDT 0.6B v3",
    sizeMb: 680,
    description: "25 European languages with auto-detection.",
    url: `${SHERPA}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
    archiveDir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
  },
  ...(
    [
      ["tiny.en", 75, "Fastest, lowest accuracy (English)."],
      ["base.en", 142, "Fast, decent accuracy (English)."],
      ["small.en", 466, "Good accuracy, slower on this CPU (English)."],
      ["medium.en", 1500, "High accuracy, slow on CPU (English)."],
      ["tiny", 75, "Multilingual, fastest."],
      ["base", 142, "Multilingual, fast."],
      ["small", 466, "Multilingual, good accuracy."],
      ["large-v3-turbo-q5_0", 548, "Multilingual, best Whisper accuracy per MB (quantized)."],
      ["large-v3-turbo", 1600, "Multilingual, best Whisper accuracy. Slow on CPU."],
    ] as const
  ).map(([id, sizeMb, description]) => ({
    id,
    engine: "whisper" as const,
    name: `Whisper ${id}`,
    sizeMb,
    description,
    url: `${HF_WHISPER}/ggml-${id}.bin`,
    file: `ggml-${id}.bin`,
  })),
  {
    id: "Qwen_Qwen3.5-2B-Q4_K_M.gguf",
    engine: "llm",
    name: "Qwen3.5 2B (Q4_K_M)",
    sizeMb: 1330,
    description: "Default local cleanup and translation model. Follows the cleanup rules reliably.",
    url: "https://huggingface.co/bartowski/Qwen_Qwen3.5-2B-GGUF/resolve/main/Qwen_Qwen3.5-2B-Q4_K_M.gguf",
    file: "Qwen_Qwen3.5-2B-Q4_K_M.gguf",
  },
  {
    id: "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
    engine: "llm",
    name: "Qwen3.5 4B (Q4_K_M)",
    sizeMb: 2870,
    description: "Better local summaries and Q&A; about 2x slower than 2B.",
    url: "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/main/Qwen_Qwen3.5-4B-Q4_K_M.gguf",
    file: "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
  },
  {
    id: "LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
    engine: "llm",
    name: "LFM2.5 1.2B (Q4_K_M)",
    sizeMb: 730,
    description: "Fastest, but unreliable at cleanup in testing (answers or drops text).",
    url: "https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/resolve/main/LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
    file: "LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
  },
  {
    id: "silero-vad",
    engine: "vad",
    name: "Silero VAD",
    sizeMb: 1,
    description: "Voice activity detection (required).",
    url: `${SHERPA}/asr-models/silero_vad.onnx`,
    file: "silero_vad.onnx",
  },
];

export function modelDef(id: string): ModelDef | undefined {
  return MODELS.find((m) => m.id === id);
}

export function modelPath(modelsDir: string, m: ModelDef): string {
  return join(modelsDir, m.engine, m.archiveDir ?? m.file ?? m.id);
}

export function isInstalled(modelsDir: string, m: ModelDef): boolean {
  const p = modelPath(modelsDir, m);
  return m.archiveDir ? existsSync(join(p, "tokens.txt")) : existsSync(p);
}

export function parakeetDir(modelsDir: string, id: string): string {
  const m = modelDef(id);
  if (!m || m.engine !== "parakeet") throw new Error(`unknown Parakeet model ${id}`);
  return modelPath(modelsDir, m);
}

export function whisperFile(modelsDir: string, id: string): string {
  return join(modelsDir, "whisper", `ggml-${id}.bin`);
}

export function vadFile(modelsDir: string): string {
  return join(modelsDir, "vad", "silero_vad.onnx");
}
