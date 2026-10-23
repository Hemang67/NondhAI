import { useEffect, useState } from "react";
import type { LlmProvider, Settings } from "@shared/settings";
import { Badge, Button, Card, Input, Row, Select, Switch } from "../components/ui";

const LLM_PROVIDERS: Array<[LlmProvider, string]> = [
  ["local", "Local (llama.cpp, offline)"],
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["gemini", "Google Gemini"],
  ["groq", "Groq"],
  ["openrouter", "OpenRouter"],
  ["custom", "OpenAI-compatible endpoint"],
];

const KEY_NAMES: Array<[string, string]> = [
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["gemini", "Google Gemini"],
  ["groq", "Groq"],
  ["openrouter", "OpenRouter"],
  ["custom", "Custom endpoint"],
];

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [info, setInfo] = useState<{ version: string; modelsDir: string; userData: string } | null>(null);

  useEffect(() => {
    void window.vd.invoke("settings:get").then(setS);
    void window.vd.invoke("secrets:status").then(setKeys);
    void window.vd.invoke("app:info").then(setInfo);
  }, []);

  if (!s) return null;
  const update = async (patch: unknown) => {
    setS(await window.vd.invoke("settings:update", patch));
    setInfo(await window.vd.invoke("app:info"));
  };

  const sttCloud = s.stt.engine === "cloud";
  const cleanupCloud = s.cleanup.llm.provider !== "local";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Settings</h1>

      <Card title="Speech to text">
        <Row label="Engine" hint={sttCloud ? <CloudNote what="Your audio" /> : "Runs on this computer."}>
          <Select value={s.stt.engine} onChange={(e) => void update({ stt: { engine: e.target.value } })}>
            <option value="parakeet">Parakeet (local, fastest)</option>
            <option value="whisper">Whisper (local, multilingual)</option>
            <option value="cloud">Cloud (your API key)</option>
          </Select>
        </Row>
        {sttCloud && (
          <>
            <Row label="Cloud provider">
              <Select value={s.stt.cloud.provider} onChange={(e) => void update({ stt: { cloud: { provider: e.target.value, model: "" } } })}>
                <option value="openai">OpenAI</option>
                <option value="groq">Groq</option>
                <option value="gemini">Google Gemini</option>
                <option value="custom">OpenAI-compatible endpoint</option>
              </Select>
            </Row>
            <Row label="Model" hint="Leave empty for the provider default.">
              <Input value={s.stt.cloud.model} onChange={(e) => void update({ stt: { cloud: { model: e.target.value } } })} />
            </Row>
            {s.stt.cloud.provider === "custom" && (
              <Row label="Base URL" hint="e.g. http://localhost:8000/v1">
                <Input value={s.stt.cloud.baseUrl} onChange={(e) => void update({ stt: { cloud: { baseUrl: e.target.value } } })} />
              </Row>
            )}
          </>
        )}
      </Card>

      <Card title="Cleanup" description="Removes fillers, applies self-corrections, fixes punctuation, and formats lists. The original is always kept in History.">
        <Row label="Clean up dictation">
          <Switch label="Clean up dictation" checked={s.cleanup.enabled} onChange={(v) => void update({ cleanup: { enabled: v } })} />
        </Row>
        <Row
          label="Use the language model"
          hint="Auto runs it only when the text has lists, “I mean”, or fillers the instant rules can't safely fix — that keeps most dictations fast."
        >
          <Select value={s.cleanup.llmMode} onChange={(e) => void update({ cleanup: { llmMode: e.target.value } })}>
            <option value="auto">Auto (recommended)</option>
            <option value="always">Always</option>
            <option value="never">Never (rules only)</option>
          </Select>
        </Row>
        <Row label="Cleanup and translation model" hint={cleanupCloud ? <CloudNote what="Your dictated text" /> : "Runs on this computer."}>
          <Select value={s.cleanup.llm.provider} onChange={(e) => void update({ cleanup: { llm: { provider: e.target.value, model: "" } } })}>
            {LLM_PROVIDERS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Row>
        {cleanupCloud && (
          <Row label="Cloud model" hint="Leave empty for the provider default.">
            <Input value={s.cleanup.llm.model} onChange={(e) => void update({ cleanup: { llm: { model: e.target.value } } })} />
          </Row>
        )}
        <Row label="Translate into" hint="Used by the translate hotkey.">
          <Input value={s.translate.target} onChange={(e) => void update({ translate: { target: e.target.value } })} />
        </Row>
      </Card>

      <Card title="Local language model">
        <Row label="Use the GPU (Vulkan)" hint="About 4x faster prompt processing on Intel Iris Xe.">
          <Switch label="Use the GPU" checked={s.llm.localGpu} onChange={(v) => void update({ llm: { localGpu: v } })} />
        </Row>
        <Row label="OpenAI-compatible base URL" hint="For the “OpenAI-compatible endpoint” provider.">
          <Input value={s.llm.customBaseUrl} placeholder="http://localhost:1234/v1" onChange={(e) => void update({ llm: { customBaseUrl: e.target.value } })} />
        </Row>
      </Card>

      <Card title="Hotkeys" description="Modifiers joined by +, optionally with one key: ctrl+win, ctrl+alt+space, ctrl+shift+f9.">
        <Row label="Dictate" hint="Hold to talk; double-tap to lock on.">
          <Input value={s.hotkeys.dictate} onChange={(e) => void update({ hotkeys: { dictate: e.target.value.toLowerCase() } })} />
        </Row>
        <Row label="Translate">
          <Input value={s.hotkeys.translate} onChange={(e) => void update({ hotkeys: { translate: e.target.value.toLowerCase() } })} />
        </Row>
      </Card>

      <Card title="API keys" description="Stored encrypted with Windows DPAPI. Only used for the providers you pick above.">
        {KEY_NAMES.map(([name, label]) => (
          <KeyRow key={name} name={name} label={label} saved={!!keys[name]} onSaved={() => void window.vd.invoke("secrets:status").then(setKeys)} />
        ))}
      </Card>

      <Card title="General">
        <Row label="Start with Windows" hint="Starts hidden in the tray.">
          <Switch label="Start with Windows" checked={s.launchAtLogin} onChange={(v) => void update({ launchAtLogin: v })} />
        </Row>
        <Row label="Restore my clipboard after pasting">
          <Switch label="Restore clipboard" checked={s.paste.restoreClipboard} onChange={(v) => void update({ paste: { restoreClipboard: v } })} />
        </Row>
        <Row label="Models folder" hint={info?.modelsDir}>
          <Button
            onClick={async () => {
              const dir = await window.vd.invoke("app:pickModelsDir");
              if (dir) await update({ modelsDir: dir });
            }}
          >
            Change…
          </Button>
        </Row>
        <p className="pt-2 text-xs text-fg-muted">
          Nondh AI {info?.version} · data in {info?.userData}
        </p>
      </Card>
    </div>
  );
}

function CloudNote({ what }: { what: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone="cloud">cloud</Badge> {what} will be sent to this provider.
    </span>
  );
}

function KeyRow({ name, label, saved, onSaved }: { name: string; label: string; saved: boolean; onSaved: () => void }) {
  const [value, setValue] = useState("");
  return (
    <Row label={label} hint={saved ? "Saved" : "Not set"}>
      <form
        className="flex gap-1.5"
        onSubmit={async (e) => {
          e.preventDefault();
          await window.vd.invoke("secrets:set", name, value);
          setValue("");
          onSaved();
        }}
      >
        <Input type="password" autoComplete="off" value={value} placeholder={saved ? "••••••••" : "Paste key"} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit">{value ? "Save" : saved ? "Clear" : "Save"}</Button>
      </form>
    </Row>
  );
}
