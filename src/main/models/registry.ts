import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "@shared/settings";

export interface ModelDef {
  id: string;
  engine: "parakeet" | "whisper" | "llm" | "vad" | "speaker";
  name: string;
  sizeMb: number;
  description: string;
  url: string;
  /** Archive downloads extract into this folder name; plain files are saved as `file`. */
  archiveDir?: string;
  file?: string;
  /** File inside archiveDir whose presence means the archive was extracted (default tokens.txt). */
  marker?: string;
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
    id: "pyannote-segmentation-3.0",
    engine: "speaker",
    name: "Pyannote segmentation 3.0",
    sizeMb: 6,
    description: "Finds who-spoke-when boundaries (meetings).",
    url: `${SHERPA}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
    archiveDir: "sherpa-onnx-pyannote-segmentation-3-0",
    marker: "model.onnx",
  },
  {
    id: "campplus-speaker-embedding",
    engine: "speaker",
    name: "3D-Speaker CAM++ voice embeddings",
    sizeMb: 28,
    description: "Voice fingerprints for telling speakers apart and recognizing them later.",
    url: `${SHERPA}/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`,
    file: "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
  },
  {
    id: "bge-small-embedding",
    engine: "llm",
    name: "BGE small en v1.5 (Q8, embeddings)",
    sizeMb: 37,
    description: "Small text-embedding model for semantic search (runs on CPU).",
    url: "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf",
    file: "bge-small-en-v1.5-q8_0.gguf",
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
  return m.archiveDir ? existsSync(join(p, m.marker ?? "tokens.txt")) : existsSync(p);
}

/** Small models every feature depends on (VAD, speaker models, search embeddings): ~60 MB. */
export const REQUIRED_MODELS = ["silero-vad", "pyannote-segmentation-3.0", "campplus-speaker-embedding", "bge-small-embedding"];

/** Everything the current settings need on disk, so a fresh install works without visiting Models. */
export function neededModels(s: Settings): string[] {
  // Meetings always run on the Parakeet worker, whatever engine dictation uses.
  const ids = [...REQUIRED_MODELS, s.stt.parakeetModel];
  if (s.stt.engine === "whisper") ids.push(s.stt.whisperModel);
  const usesLocal =
    (s.cleanup.enabled && s.cleanup.llm.provider === "local") ||
    s.llm.assistant.provider === "local" ||
    (s.meetings.summarize && s.llm.summaries.provider === "local");
  if (usesLocal) ids.push(s.llm.localModel);
  return ids.filter((id, i) => modelDef(id) && ids.indexOf(id) === i);
}

export function parakeetDir(modelsDir: string, id: string): string {
  const m = modelDef(id);
  if (!m || m.engine !== "parakeet") throw new Error(`unknown Parakeet model ${id}`);
  return modelPath(modelsDir, m);
}

export function whisperFile(modelsDir: string, id: string): string {
  return join(modelsDir, "whisper", `ggml-${id}.bin`);
}

export function diarizationFiles(modelsDir: string): { segmentation: string; embedding: string } | null {
  const seg = modelDef("pyannote-segmentation-3.0")!;
  const emb = modelDef("campplus-speaker-embedding")!;
  if (!isInstalled(modelsDir, seg) || !isInstalled(modelsDir, emb)) return null;
  return { segmentation: join(modelPath(modelsDir, seg), "model.onnx"), embedding: modelPath(modelsDir, emb) };
}

export const SPEAKER_MODEL = "campplus-v1";

export function vadFile(modelsDir: string): string {
  return join(modelsDir, "vad", "silero_vad.onnx");
}
