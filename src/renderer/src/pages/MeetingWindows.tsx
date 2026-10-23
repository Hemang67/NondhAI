import { useEffect, useRef, useState } from "react";
import type { AssistantState, RecordingState, ScreenSource, ScreenState } from "@shared/ipc";
import type { TranscriptLine } from "@shared/meeting/types";
import { Badge, Button } from "../components/ui";
import { Markdown } from "../components/Markdown";
import { clock, speakerColor } from "../nav";

function useRecording() {
  const [rec, setRec] = useState<RecordingState | null>(null);
  useEffect(() => {
    void window.vd.invoke("meetings:recording").then(setRec);
    return window.vd.on("meeting:state", setRec);
  }, []);
  return rec;
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Level({ value, label }: { value: number; label: string }) {
  const pct = Math.min(100, Math.round(Math.sqrt(value) * 220));
  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted">
      <span className="w-14">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted" role="meter" aria-label={`${label} level`} aria-valuenow={pct}>
        <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Live transcript window shown while a meeting is recorded. */
export function MeetingLive() {
  const rec = useRecording();
  const now = useNow();
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [levels, setLevels] = useState({ mic: 0, system: 0 });
  const [copied, setCopied] = useState(false);
  const [lastId, setLastId] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (rec) {
      setLastId(rec.id);
      setLines([]);
    }
  }, [rec?.id]);
  useEffect(
    () =>
      window.vd.on("meeting:line", (id, line) => {
        if (rec && id !== rec.id) return;
        setLines((ls) => [...ls, line].sort((a, b) => a.start - b.start));
      }),
    [rec],
  );
  useEffect(() => window.vd.on("meeting:level", (mic, system) => setLevels({ mic, system })), []);
  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [lines.length]);

  if (!rec) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-medium">Recording stopped</p>
        <p className="text-sm text-fg-muted">The accurate transcript, speaker names and summary are being prepared. They appear in Nondh AI → Meetings.</p>
        {lastId && <Button onClick={() => window.close()}>Close</Button>}
      </div>
    );
  }
  const name = (k: string) => (k === "me" ? "Me" : k === "others" ? "Others" : "Speaker");
  return (
    <div className="flex h-full flex-col">
      <header className="space-y-2 border-b border-line p-3">
        <div className="flex items-center gap-2">
          <span className="size-2.5 animate-pulse rounded-full bg-red-500" aria-hidden />
          <span className="font-semibold">Recording</span>
          <span className="tabular-nums text-fg-muted">{clock(now - rec.startedAt)}</span>
          <Button variant="danger" className="ml-auto h-7" onClick={() => void window.vd.invoke("meetings:stop")}>
            Stop
          </Button>
        </div>
        <div className="truncate text-xs text-fg-muted">{rec.title}</div>
        <Level value={levels.mic} label="My mic" />
        {rec.kind === "call" && <Level value={levels.system} label="Call" />}
        <ScreenControls />
        <div className="rounded-md bg-amber-500/10 p-2 text-xs leading-relaxed">
          Many places require everyone's consent to record, even on calls you don't host. Let them know:
          <Button
            className="ml-2 h-6 px-2 text-xs"
            onClick={async () => {
              await window.vd.invoke("meetings:copyConsent");
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy consent message"}
          </Button>
        </div>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto p-3" aria-live="polite">
        {lines.length === 0 && <p className="text-sm text-fg-muted">Listening… lines appear a few seconds after they're spoken.</p>}
        {lines.map((l) => (
          <div key={l.id}>
            <span className="text-xs font-semibold" style={{ color: speakerColor(l.speakerKey) }}>
              {name(l.speakerKey)}
            </span>
            <span className="ml-2 text-xs text-fg-muted">{clock(l.start)}</span>
            <p className="text-sm leading-relaxed">{l.text}</p>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <footer className="border-t border-line p-2 text-[11px] text-fg-muted">
        Live text is a preview. After the call: full re-transcription, speaker separation and summary.
      </footer>
    </div>
  );
}

/** Always-visible REC chip at the top of the screen while recording. */
export function RecIndicator() {
  const rec = useRecording();
  const screen = useScreenState();
  const now = useNow();
  const [level, setLevel] = useState(0);
  useEffect(() => {
    document.documentElement.classList.add("pill-root");
    return window.vd.on("meeting:level", (mic, system) => setLevel(Math.max(mic, system)));
  }, []);
  if (!rec) return null;
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="flex items-center gap-2 rounded-full bg-neutral-900/95 px-3 py-1.5 text-xs font-medium text-white shadow-lg" role="status">
        <span className="size-2 rounded-full bg-red-500" style={{ opacity: 0.5 + Math.min(0.5, level * 20) }} />
        REC {clock(now - rec.startedAt)}
        <span className="text-neutral-400">{rec.kind === "call" ? "call" : "room"}</span>
        {screen && <span className="rounded bg-red-500 px-1.5 py-px text-[10px] font-bold tracking-wide">SCREEN</span>}
      </div>
    </div>
  );
}

function useScreenState() {
  const [s, setS] = useState<ScreenState | null>(null);
  useEffect(() => {
    void window.vd.invoke("screen:state").then(setS);
    return window.vd.on("screen:state", setS);
  }, []);
  return s;
}

const MonitorIcon = () => (
  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </svg>
);

/**
 * "Record screen" in the live meeting window: pick the entire screen, one window, or a region,
 * then start/stop as many clips as needed during the meeting.
 */
function ScreenControls() {
  const screen = useScreenState();
  const now = useNow();
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState("");

  if (screen) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-red-500/10 p-2 text-xs">
        <span className="size-2 animate-pulse rounded-full bg-red-500" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          Recording screen · {screen.label} · <span className="tabular-nums">{clock(now - screen.startedAt)}</span>
        </span>
        <Button variant="danger" className="h-7" onClick={() => void window.vd.invoke("screen:stop")}>
          Stop screen
        </Button>
      </div>
    );
  }
  return (
    <div>
      <Button className="h-7 w-full" onClick={() => setPicker(true)} title="Record your screen, a window, or a region while the meeting runs">
        <MonitorIcon /> Record screen
      </Button>
      {error && <p className="mt-1 text-xs text-warn">{error}</p>}
      {picker && (
        <SourcePicker
          onClose={() => setPicker(false)}
          onError={(m) => {
            setError(m);
            setPicker(false);
          }}
        />
      )}
    </div>
  );
}

function SourcePicker({ onClose, onError }: { onClose: () => void; onError: (m: string) => void }) {
  const [tab, setTab] = useState<"screen" | "window" | "region">("screen");
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  useEffect(() => {
    void window.vd.invoke("screen:sources").then(setSources).catch((e: Error) => onError(e.message));
  }, []);
  const screens = sources?.filter((s) => s.kind === "screen") ?? [];
  const wins = sources?.filter((s) => s.kind === "window") ?? [];
  const clean = (m: string) => m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

  const start = async (src: ScreenSource, kind: "screen" | "window" | "region") => {
    try {
      if (kind === "region") {
        onClose();
        const picked = await window.vd.invoke("screen:pickRegion", src.displayId);
        if (!picked) return;
        await window.vd.invoke("screen:start", { sourceId: src.id, kind, label: `Region of ${src.name}`, region: picked.rect, displayId: picked.displayId });
      } else {
        await window.vd.invoke("screen:start", { sourceId: src.id, kind, label: src.name });
        onClose();
      }
    } catch (e) {
      onError(clean((e as Error).message));
    }
  };

  const list = tab === "window" ? wins : screens;
  return (
    <div className="fixed inset-0 z-10 flex flex-col bg-bg" role="dialog" aria-label="Choose what to record">
      <div className="flex items-center gap-2 border-b border-line p-3">
        <span className="font-semibold">Record screen</span>
        <button className="ml-auto text-fg-muted hover:text-fg" onClick={onClose} aria-label="Cancel">
          ✕
        </button>
      </div>
      <div className="flex gap-1 border-b border-line px-3" role="tablist">
        {(
          [
            ["screen", "Entire screen"],
            ["window", "Window"],
            ["region", "Region"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? "border-accent font-medium" : "border-transparent text-fg-muted"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="px-3 pt-2 text-xs text-fg-muted">
        {tab === "region"
          ? "Pick a screen, then drag a rectangle over the part you want to record."
          : "Only what you choose is recorded, and only until you press Stop. Nondh AI's own windows are never captured."}
      </p>
      <div className="grid flex-1 grid-cols-2 content-start gap-3 overflow-y-auto p-3">
        {!sources && <p className="col-span-2 text-sm text-fg-muted">Loading…</p>}
        {sources && list.length === 0 && <p className="col-span-2 text-sm text-fg-muted">Nothing to show.</p>}
        {list.map((s) => (
          <button
            key={s.id}
            onClick={() => void start(s, tab === "region" ? "region" : s.kind)}
            className="rounded-md border border-line p-1.5 text-left hover:border-accent hover:bg-muted/50"
          >
            <img src={s.thumbnail} alt="" className="aspect-video w-full rounded bg-black object-contain" />
            <span className="mt-1 block truncate text-xs">{s.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Meeting detected — record?" and "Call ended — stop?" prompts. */
export function Toast() {
  const [info, setInfo] = useState<{ kind: "detected" | "ended"; app: string } | null>(null);
  useEffect(() => {
    document.documentElement.classList.add("pill-root");
    return window.vd.on("toast:show", setInfo);
  }, []);
  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => void window.vd.invoke("toast:respond", "dismiss"), 30000);
    return () => clearTimeout(t);
  }, [info]);
  if (!info) return null;
  return (
    <div className="flex h-screen items-start p-2">
      <div className="w-full rounded-lg border border-white/10 bg-neutral-900 p-4 text-sm text-neutral-100 shadow-xl" role="alertdialog" aria-label="Meeting">
        <div className="flex items-center gap-2">
          <span className={`size-2.5 rounded-full ${info.kind === "detected" ? "animate-pulse bg-sky-400" : "bg-neutral-500"}`} aria-hidden />
          <p className="font-semibold">{info.kind === "detected" ? "Meeting detected" : "Meeting ended"}</p>
          <span className="ml-auto truncate text-xs text-neutral-400">{info.app}</span>
        </div>
        <p className="mt-1.5 text-xs text-neutral-400">
          {info.kind === "detected"
            ? `${info.app} is using your microphone. Capture and transcribe this meeting? A REC indicator stays visible while it runs.`
            : `${info.app} stopped using the microphone. Stop capturing?`}
        </p>
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={() => void window.vd.invoke("toast:respond", info.kind === "detected" ? "record" : "stop")}>
            {info.kind === "detected" ? "Start Capturing" : "Stop Capturing"}
          </Button>
          <Button variant="ghost" className="text-neutral-200" onClick={() => void window.vd.invoke("toast:respond", "dismiss")}>
            {info.kind === "detected" ? "Not now" : "Keep capturing"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Floating answer panel for the voice assistant. */
export function AssistantPanel() {
  const [s, setS] = useState<AssistantState | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    document.documentElement.classList.add("pill-root");
    const off = window.vd.on("assistant:state", setS);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && void window.vd.invoke("assistant:close");
    window.addEventListener("keydown", esc);
    return () => {
      off();
      window.removeEventListener("keydown", esc);
    };
  }, []);
  if (!s) return null;
  return (
    <div className="h-screen p-2">
      <div className="flex h-full flex-col rounded-xl border border-line bg-panel shadow-2xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-2" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
          <span className="text-sm font-semibold">Assistant</span>
          {s.cloud && <Badge tone="cloud">cloud</Badge>}
          <button
            className="ml-auto text-fg-muted hover:text-fg"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            onClick={() => void window.vd.invoke("assistant:close")}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          {s.command && <p className="mb-3 text-sm text-fg-muted">“{s.command}”</p>}
          {s.phase === "thinking" && <p className="text-sm">Thinking…</p>}
          {s.phase === "error" && <p className="text-sm text-warn">{s.error}</p>}
          {s.phase === "answer" && s.answer && <Markdown text={s.answer} className="text-sm" />}
        </div>
        {s.phase === "answer" && (
          <footer className="flex gap-2 border-t border-line p-3">
            <Button
              onClick={async () => {
                await navigator.clipboard.writeText(s.answer ?? "");
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="primary" onClick={() => void window.vd.invoke("assistant:paste")}>
              Paste at cursor
            </Button>
          </footer>
        )}
      </div>
    </div>
  );
}
