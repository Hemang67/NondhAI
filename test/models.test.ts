import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "@shared/settings";
import { SPEAKER_MODEL, diarizationFiles, modelDef, neededModels } from "../src/main/models/registry";

const local = { provider: "local" as const, model: "" };
const cloud = { provider: "anthropic" as const, model: "claude-opus-5-5" };

describe("neededModels", () => {
  it("includes the small required models and the Parakeet model meetings run on", () => {
    const ids = neededModels(mergeSettings({ stt: { engine: "cloud" }, cleanup: { llm: cloud } }));
    expect(ids).toEqual(["silero-vad", "pyannote-segmentation-3.0", "titanet-small-speaker-embedding", "bge-small-embedding", DEFAULT_SETTINGS.stt.parakeetModel]);
  });

  it("adds the selected Whisper model when dictation uses Whisper", () => {
    const ids = neededModels(mergeSettings({ stt: { engine: "whisper", whisperModel: "base.en" }, cleanup: { llm: cloud } }));
    expect(ids).toContain("base.en");
  });

  it("adds the local chat model when any feature uses it", () => {
    const s = mergeSettings({ cleanup: { enabled: true, llm: local }, llm: { localModel: "Qwen_Qwen3.5-2B-Q4_K_M.gguf" } });
    expect(neededModels(s)).toContain("Qwen_Qwen3.5-2B-Q4_K_M.gguf");
    const summaries = mergeSettings({ cleanup: { llm: cloud }, llm: { summaries: local } });
    expect(neededModels(summaries)).toContain(summaries.llm.localModel);
  });

  it("skips the local chat model when nothing uses it", () => {
    const s = mergeSettings({ cleanup: { enabled: false, llm: local }, llm: { assistant: cloud, summaries: cloud }, meetings: { summarize: false } });
    expect(neededModels(s)).not.toContain(s.llm.localModel);
  });

  it("ignores model names that aren't in the catalog (custom GGUF files)", () => {
    const s = mergeSettings({ cleanup: { enabled: true, llm: local }, llm: { localModel: "my-own.gguf" } });
    expect(neededModels(s)).not.toContain("my-own.gguf");
  });
});

describe("speaker models", () => {
  it("recognizes voices with NeMo TitaNet-small, chosen by the speaker evaluation (docs/SPEAKER_ID_AUDIT.md)", () => {
    expect(modelDef("titanet-small-speaker-embedding")).toMatchObject({ engine: "speaker", file: "nemo_en_titanet_small.onnx" });
    expect(SPEAKER_MODEL).toBe("titanet-small-v1");
  });

  it("needs no speaker files that are not installed", () => {
    expect(diarizationFiles("Z:/nowhere")).toBeNull();
  });
});
