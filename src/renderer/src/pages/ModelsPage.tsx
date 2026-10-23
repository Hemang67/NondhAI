import { useEffect, useState } from "react";
import type { ModelInfo } from "@shared/types";
import type { Settings } from "@shared/settings";
import { Badge, Button, Card } from "../components/ui";

const GROUPS: Array<{ engine: ModelInfo["engine"]; title: string; description: string }> = [
  { engine: "parakeet", title: "Parakeet", description: "Fast local speech recognition. Default engine." },
  { engine: "speaker", title: "Speaker models", description: "Tell speakers apart and recognize voices in meetings (downloaded automatically)." },
  { engine: "whisper", title: "Whisper", description: "Multilingual local speech recognition (whisper.cpp)." },
  { engine: "llm", title: "Local language models", description: "Used for cleanup, translation and, later, summaries (llama.cpp)." },
];

/** Speaker and search-embedding models are used automatically, never "picked". */
const selectable = (m: ModelInfo) => m.engine !== "speaker" && m.id !== "bge-small-embedding";

export function ModelsPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    void window.vd.invoke("models:list").then(setModels);
    void window.vd.invoke("settings:get").then(setSettings);
  };
  useEffect(load, []);
  useEffect(() => window.vd.on("models:changed", () => void window.vd.invoke("models:list").then(setModels)), []);

  const active = (m: ModelInfo) =>
    !!settings &&
    ((m.engine === "parakeet" && settings.stt.engine === "parakeet" && settings.stt.parakeetModel === m.id) ||
      (m.engine === "whisper" && settings.stt.engine === "whisper" && settings.stt.whisperModel === m.id) ||
      (m.engine === "llm" && settings.llm.localModel === m.id));

  const use = async (m: ModelInfo) => {
    const patch =
      m.engine === "parakeet"
        ? { stt: { engine: "parakeet", parakeetModel: m.id } }
        : m.engine === "whisper"
          ? { stt: { engine: "whisper", whisperModel: m.id } }
          : { llm: { localModel: m.id } };
    setSettings(await window.vd.invoke("settings:update", patch));
  };

  const download = (id: string) => {
    setError(null);
    window.vd.invoke("models:download", id).catch((e: Error) => setError(e.message));
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Models</h1>
      {error && <p className="rounded-md border border-line bg-panel p-3 text-sm text-warn">{error}</p>}
      {GROUPS.map((g) => (
        <Card key={g.engine} title={g.title} description={g.description}>
          <ul className="divide-y divide-line">
            {models
              .filter((m) => m.engine === g.engine)
              .map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {m.name}
                      {active(m) && <Badge tone="accent">in use</Badge>}
                    </div>
                    <div className="text-xs text-fg-muted">
                      {m.description} · {m.sizeMb >= 1000 ? `${(m.sizeMb / 1000).toFixed(1)} GB` : `${m.sizeMb} MB`}
                    </div>
                    {m.downloading && (
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={Math.round((m.downloading.received / m.downloading.total) * 100)}>
                        <div className="h-full bg-accent" style={{ width: `${(m.downloading.received / m.downloading.total) * 100}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1.5">
                    {m.downloading ? (
                      <Button onClick={() => void window.vd.invoke("models:cancel", m.id)}>Cancel</Button>
                    ) : m.installed ? (
                      <>
                        {!active(m) && selectable(m) && (
                          <Button variant="primary" onClick={() => void use(m)}>
                            Use
                          </Button>
                        )}
                        <Button variant="danger" disabled={active(m) || !selectable(m)} onClick={() => void window.vd.invoke("models:delete", m.id)}>
                          Delete
                        </Button>
                      </>
                    ) : (
                      <Button onClick={() => download(m.id)}>Download</Button>
                    )}
                  </div>
                </li>
              ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
