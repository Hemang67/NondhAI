import { encodeWav } from "@shared/audio/wav";
import type { CloudSttProvider } from "@shared/settings";
import { getSecret } from "../secrets";

const ENDPOINTS: Record<Exclude<CloudSttProvider, "custom" | "gemini">, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
};

export const DEFAULT_STT_MODELS: Record<CloudSttProvider, string> = {
  openai: "gpt-4o-mini-transcribe",
  groq: "whisper-large-v3-turbo",
  gemini: "gemini-2.5-flash",
  custom: "whisper-1",
};

/** Sends audio to the user's cloud provider. Callers must have shown the "cloud" indicator. */
export async function cloudTranscribe(
  samples: Float32Array,
  cfg: { provider: CloudSttProvider; model: string; baseUrl: string; language: string; prompt?: string },
): Promise<string> {
  const key = getSecret(cfg.provider);
  if (!key) throw new Error(`No API key saved for ${cfg.provider}`);
  const wav = encodeWav(samples, 16000);
  const model = cfg.model || DEFAULT_STT_MODELS[cfg.provider];

  if (cfg.provider === "gemini") {
    const b64 = Buffer.from(wav).toString("base64");
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: "Transcribe this audio verbatim. Output only the transcript." + (cfg.prompt ? ` Vocabulary: ${cfg.prompt}` : "") },
                { inline_data: { mime_type: "audio/wav", data: b64 } },
              ],
            },
          ],
        }),
      },
    );
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = (await r.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  }

  const base = cfg.provider === "custom" ? cfg.baseUrl : ENDPOINTS[cfg.provider];
  if (!base) throw new Error("No endpoint configured for custom transcription");
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.append("model", model);
  form.append("response_format", "json");
  if (cfg.language && cfg.language !== "auto") form.append("language", cfg.language);
  if (cfg.prompt) form.append("prompt", cfg.prompt);
  const r = await fetch(`${base.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  if (!r.ok) throw new Error(`${cfg.provider} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (((await r.json()) as { text?: string }).text ?? "").trim();
}
