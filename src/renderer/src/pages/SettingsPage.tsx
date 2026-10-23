import { useEffect, useState } from "react";
import type { LlmProvider, LlmTarget, Settings } from "@shared/settings";
import { APP_NAME, DEVELOPER, TAGLINE, TAGLINE_MEANING } from "@shared/brand";
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

type Info = Awaited<ReturnType<typeof window.vd.invoke<"app:info">>>;

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [info, setInfo] = useState<Info | null>(null);

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

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-fg-muted">
          {APP_NAME} · <span className="italic">{TAGLINE}</span>
        </p>
      </header>

      <Card title="Speech to text">
        <Row label="Dictation engine" hint={sttCloud ? <CloudNote what="Your dictation audio" /> : "Runs on this computer. Meetings always transcribe locally."}>
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

      <Card title="Cleanup" description="Removes fillers, applies self-corrections, fixes punctuation, and formats lists. The original is always kept in Dictations.">
        <Row label="Clean up dictation">
          <Switch label="Clean up dictation" checked={s.cleanup.enabled} onChange={(v) => void update({ cleanup: { enabled: v } })} />
        </Row>
        <Row label="Use the language model" hint="Auto runs it only when the instant rules can't safely handle the text — most dictations stay instant.">
          <Select value={s.cleanup.llmMode} onChange={(e) => void update({ cleanup: { llmMode: e.target.value } })}>
            <option value="auto">Auto (recommended)</option>
            <option value="always">Always</option>
            <option value="never">Never (rules only)</option>
          </Select>
        </Row>
        <ModelRow label="Cleanup and translation model" target={s.cleanup.llm} onChange={(t) => void update({ cleanup: { llm: t } })} what="Your dictated text" />
        <Row label="Translate into" hint="Used by Ctrl+Win+T.">
          <Input value={s.translate.target} onChange={(e) => void update({ translate: { target: e.target.value } })} />
        </Row>
      </Card>

      <Card title="Meetings">
        <Row label="Detect calls and offer to record" hint="Zoom, Teams, Google Meet, Webex, Slack huddles, Discord. Nothing records without your click.">
          <Switch label="Detect calls" checked={s.meetings.autoDetect} onChange={(v) => void update({ meetings: { autoDetect: v } })} />
        </Row>
        {s.meetings.autoDetect && (
          <Row label="Detect any app" hint="On: any app or browser that starts using the microphone shows “Start Capturing”. Off: only known meeting apps.">
            <Switch label="Detect any app" checked={s.meetings.detectAnyApp} onChange={(v) => void update({ meetings: { detectAnyApp: v } })} />
          </Row>
        )}
        <Row label="Echo cancellation" hint="Removes the other side's voice from your mic when you're on speakers. Text-level duplicate removal always runs.">
          <Switch label="Echo cancellation" checked={s.meetings.aec} onChange={(v) => void update({ meetings: { aec: v } })} />
        </Row>
        <Row label="Summarize automatically" hint="Key points, decisions, action items with owners, open questions.">
          <Switch label="Summarize automatically" checked={s.meetings.summarize} onChange={(v) => void update({ meetings: { summarize: v } })} />
        </Row>
        <ModelRow label="Summaries, Q&A and note actions" target={s.llm.summaries} onChange={(t) => void update({ llm: { summaries: t } })} what="Meeting transcripts" />
        <Row label="Keep recordings for" hint="Transcripts and summaries are always kept.">
          <Select value={String(s.meetings.keepAudioDays)} onChange={(e) => void update({ meetings: { keepAudioDays: Number(e.target.value) } })}>
            <option value="0">Forever</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
          </Select>
        </Row>
        <Row label="Consent message" hint="Copied with one click when a recording starts.">
          <Input value={s.meetings.consentMessage} onChange={(e) => void update({ meetings: { consentMessage: e.target.value } })} />
        </Row>
        <Row label="Recordings folder" hint={info?.meetingsDir}>
          <Button
            onClick={async () => {
              const dir = await window.vd.invoke("app:pickFolder");
              if (dir) await update({ meetings: { dir } });
            }}
          >
            Change…
          </Button>
        </Row>
      </Card>

      <Card title="Assistant" description="Ctrl+Win+A: speak a command. With text selected, it edits the selection in place; otherwise it answers.">
        <ModelRow label="Assistant model" target={s.llm.assistant} onChange={(t) => void update({ llm: { assistant: t } })} what="Your command and any selected text" />
        <Row label="Answers" hint="Show in a floating panel, or type them at the cursor.">
          <Select value={s.assistant.answerMode} onChange={(e) => void update({ assistant: { answerMode: e.target.value } })}>
            <option value="panel">Floating panel</option>
            <option value="paste">Paste at cursor</option>
          </Select>
        </Row>
        <Row label="Include a screenshot" hint={<span>Sends your screen to the cloud model as context. <Badge tone="cloud">cloud only</Badge></span>}>
          <Switch label="Include a screenshot" checked={s.assistant.includeScreenshot} onChange={(v) => void update({ assistant: { includeScreenshot: v } })} />
        </Row>
      </Card>

      <Card title="Local language model">
        <Row label="Use the GPU (Vulkan)" hint="About 4x faster prompt processing on Intel Iris Xe.">
          <Switch label="Use the GPU" checked={s.llm.localGpu} onChange={(v) => void update({ llm: { localGpu: v } })} />
        </Row>
        <Row label="OpenAI-compatible base URL" hint="For the “OpenAI-compatible endpoint” provider (LM Studio, Ollama, vLLM…).">
          <Input value={s.llm.customBaseUrl} placeholder="http://localhost:1234/v1" onChange={(e) => void update({ llm: { customBaseUrl: e.target.value } })} />
        </Row>
      </Card>

      <Card title="Hotkeys" description="Modifiers joined by +, optionally with one key: ctrl+win, ctrl+alt+space, ctrl+shift+f9.">
        {(["dictate", "translate", "assistant", "meeting"] as const).map((k) => (
          <Row key={k} label={{ dictate: "Dictate (hold, or double-tap to lock)", translate: "Translate", assistant: "Assistant", meeting: "Start / stop meeting recording" }[k]}>
            <Input value={s.hotkeys[k]} onChange={(e) => void update({ hotkeys: { [k]: e.target.value.toLowerCase() } })} />
          </Row>
        ))}
      </Card>

      <Card title="API keys" description="Stored encrypted with Windows DPAPI. Only used for the providers you pick above.">
        {KEY_NAMES.map(([name, label]) => (
          <KeyRow key={name} name={name} label={label} saved={!!keys[name]} onSaved={() => void window.vd.invoke("secrets:status").then(setKeys)} />
        ))}
      </Card>

      <CalendarCard s={s} update={update} />
      <IntegrationsCard s={s} info={info} update={update} />
      <PrivacyCard s={s} onChange={() => void window.vd.invoke("settings:get").then(setS)} />

      <UpdatesCard s={s} update={update} />

      <Card title="General">
        <Row label="Start with Windows" hint="Starts hidden in the tray (installed app).">
          <Switch label="Start with Windows" checked={s.launchAtLogin} onChange={(v) => void update({ launchAtLogin: v })} />
        </Row>
        <Row label="Restore my clipboard after pasting">
          <Switch label="Restore clipboard" checked={s.paste.restoreClipboard} onChange={(v) => void update({ paste: { restoreClipboard: v } })} />
        </Row>
        <Row label="Models folder" hint={info?.modelsDir}>
          <Button
            onClick={async () => {
              const dir = await window.vd.invoke("app:pickFolder");
              if (dir) await update({ modelsDir: dir });
            }}
          >
            Change…
          </Button>
        </Row>
      </Card>

      <Card title="About">
        <div className="flex items-center gap-4">
          <img src="./icon.png" alt="" className="size-14 shrink-0" />
          <div className="min-w-0">
            <div className="text-base font-semibold">{APP_NAME}</div>
            <div className="text-sm italic">{TAGLINE}</div>
            <div className="text-xs text-fg-muted">“{TAGLINE_MEANING}”</div>
          </div>
        </div>
        <div className="mt-4 border-t border-line pt-3">
          <div className="text-xs uppercase tracking-wide text-fg-muted">Developed by</div>
          <div className="mt-0.5 text-sm font-semibold">{DEVELOPER.name}</div>
          <div className="text-xs text-accent">{DEVELOPER.role}</div>
          <div className="mt-1 text-xs">{DEVELOPER.motto}</div>
          <div className="text-xs text-fg-muted">{DEVELOPER.line}</div>
          <a
            href={DEVELOPER.url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            {DEVELOPER.url.replace(/^https:\/\//, "").replace(/\/$/, "")} <span aria-hidden="true">↗</span>
          </a>
        </div>
        <p className="mt-3 text-xs text-fg-muted">
          Version {info?.version} · © 2026 {DEVELOPER.name} · everything is stored on this computer, in {info?.userData}
        </p>
      </Card>
    </div>
  );
}

function ModelRow({ label, target, onChange, what }: { label: string; target: LlmTarget; onChange: (t: LlmTarget) => void; what: string }) {
  return (
    <>
      <Row label={label} hint={target.provider !== "local" ? <CloudNote what={what} /> : "Runs on this computer."}>
        <Select value={target.provider} onChange={(e) => onChange({ provider: e.target.value as LlmProvider, model: "" })}>
          {LLM_PROVIDERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Row>
      {target.provider !== "local" && (
        <Row label="Model" hint="Leave empty for the provider default.">
          <Input value={target.model} onChange={(e) => onChange({ ...target, model: e.target.value })} />
        </Row>
      )}
    </>
  );
}

function CalendarCard({ s, update }: { s: Settings; update: (p: unknown) => Promise<void> }) {
  const [status, setStatus] = useState({ google: false, microsoft: false });
  const [events, setEvents] = useState<Array<{ id: string; title: string; start: number; attendees: string[] }>>([]);
  const [error, setError] = useState("");
  const refresh = () => {
    void window.vd.invoke("calendar:status").then(setStatus);
    void window.vd.invoke("calendar:upcoming").then(setEvents).catch(() => {});
  };
  useEffect(refresh, []);
  const connect = async (p: "google" | "microsoft") => {
    setError("");
    try {
      await window.vd.invoke("calendar:connect", p);
      refresh();
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  return (
    <Card
      title="Calendar"
      description="Read-only. Meetings get their title from the calendar event, and attendee names are offered when you name speakers. Uses your own OAuth app (see docs/CALENDAR.md)."
    >
      <Row label="Google client ID">
        <Input value={s.calendar.googleClientId} onChange={(e) => void update({ calendar: { googleClientId: e.target.value.trim() } })} />
      </Row>
      <Row label="Google client secret" hint="Google issues one even for desktop apps.">
        <Input type="password" value={s.calendar.googleClientSecret} onChange={(e) => void update({ calendar: { googleClientSecret: e.target.value.trim() } })} />
      </Row>
      <Row label="Microsoft client ID" hint="Azure app registration, “Mobile and desktop” redirect http://localhost.">
        <Input value={s.calendar.microsoftClientId} onChange={(e) => void update({ calendar: { microsoftClientId: e.target.value.trim() } })} />
      </Row>
      <div className="flex flex-wrap gap-2 pt-2">
        {(["google", "microsoft"] as const).map((p) =>
          status[p] ? (
            <Button key={p} onClick={() => void window.vd.invoke("calendar:disconnect", p).then(refresh)}>
              Disconnect {p === "google" ? "Google" : "Microsoft"}
            </Button>
          ) : (
            <Button key={p} variant="primary" onClick={() => void connect(p)}>
              Connect {p === "google" ? "Google" : "Microsoft"}
            </Button>
          ),
        )}
      </div>
      {error && <p className="pt-2 text-sm text-warn">{error}</p>}
      {events.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {events.slice(0, 5).map((e) => (
            <li key={e.id}>
              <span className="text-fg-muted">{new Date(e.start).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span> {e.title}
              {e.attendees.length > 0 && <span className="text-xs text-fg-muted"> · {e.attendees.length} attendees</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function IntegrationsCard({ s, info, update }: { s: Settings; info: Info | null; update: (p: unknown) => Promise<void> }) {
  const [copied, setCopied] = useState("");
  const copy = async (what: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(""), 1500);
  };
  return (
    <Card title="Integrations" description="Let other tools (and AI assistants like Claude Code) read your meetings, notes and dictations. Localhost only.">
      <Row label="Local API" hint={`http://127.0.0.1:${s.api.port} · every request needs the token`}>
        <Switch label="Local API" checked={s.api.enabled} onChange={(v) => void update({ api: { enabled: v } })} />
      </Row>
      {s.api.enabled && info?.apiToken && (
        <Row label="API token">
          <Button onClick={() => void copy("token", info.apiToken!)}>{copied === "token" ? "Copied" : "Copy token"}</Button>
        </Row>
      )}
      <Row label="MCP server for Claude Code" hint="Needs the local API on. Run this once in a terminal:">
        <Button onClick={() => info && void copy("mcp", info.mcpCommand)}>{copied === "mcp" ? "Copied" : "Copy command"}</Button>
      </Row>
      {info && <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-[11px]">{info.mcpCommand}</pre>}
    </Card>
  );
}

function PrivacyCard({ s, onChange }: { s: Settings; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Privacy and data" description="Everything is stored on this computer. Cloud providers only see what the settings above send them, and it's marked “cloud” wherever that happens.">
      <Row label="Encrypt the database" hint="SQLCipher; the key is protected by Windows (DPAPI).">
        <Switch
          label="Encrypt the database"
          checked={s.privacy.encryptDatabase}
          onChange={async (v) => {
            setBusy(true);
            await window.vd.invoke("app:setDatabaseEncryption", v);
            setBusy(false);
            onChange();
          }}
        />
      </Row>
      <Row label="Encrypt new recordings" hint="AES-256-GCM; played back without writing a decrypted copy to disk.">
        <Switch
          label="Encrypt new recordings"
          checked={s.meetings.encryptAudio}
          onChange={async (v) => {
            await window.vd.invoke("settings:update", { meetings: { encryptAudio: v } });
            onChange();
          }}
        />
      </Row>
      <div className="flex flex-wrap gap-2 pt-3">
        <Button variant="danger" disabled={busy} onClick={() => confirm("Delete the audio of every meeting? Transcripts and summaries are kept.") && void window.vd.invoke("app:deleteAllAudio")}>
          Delete all recordings
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() =>
            confirm("Delete EVERYTHING: all meetings, recordings, notes, dictations, people and voices? This cannot be undone.") &&
            void window.vd.invoke("app:deleteEverything")
          }
        >
          Delete everything
        </Button>
      </div>
    </Card>
  );
}

function UpdatesCard({ s, update }: { s: Settings; update: (p: unknown) => Promise<void> }) {
  const [st, setSt] = useState<{ state: string; version?: string; error?: string }>({ state: "off" });
  useEffect(() => {
    void window.vd.invoke("updates:status").then(setSt);
    return window.vd.on("updates:status", setSt);
  }, []);
  const label: Record<string, string> = {
    off: "Automatic updates are off.",
    idle: "Waiting to check.",
    checking: "Checking…",
    none: "You're up to date.",
    downloading: `Downloading ${st.version ?? ""}…`,
    ready: `Version ${st.version} is ready.`,
    error: `Update check failed: ${st.error ?? ""}`,
  };
  return (
    <Card title="Updates" description="Point Nondh AI at a folder or web address where you put new builds (latest.yml + the installer). Updates download in the background and install on restart.">
      <Row label="Update source" hint="e.g. D:\Nondh AI-releases or https://example.com/nondh-ai">
        <Input defaultValue={s.updates.feedUrl} onBlur={(e) => void update({ updates: { feedUrl: e.target.value.trim() } })} />
      </Row>
      <div className="flex items-center gap-2 pt-2 text-sm">
        <span className="text-fg-muted">{label[st.state] ?? st.state}</span>
        {st.state !== "off" && <Button onClick={() => void window.vd.invoke("updates:check")}>Check now</Button>}
        {st.state === "ready" && (
          <Button variant="primary" onClick={() => void window.vd.invoke("updates:install")}>
            Restart and update
          </Button>
        )}
      </div>
    </Card>
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
