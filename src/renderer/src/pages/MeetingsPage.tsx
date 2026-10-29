import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipRecord, MeetingRecord } from "@shared/types";
import type { ExportFormat, MeetingDetail } from "@shared/ipc";
import type { TranscriptLine } from "@shared/meeting/types";
import { Badge, Button, cx, Input } from "../components/ui";
import { Markdown } from "../components/Markdown";
import { clock, CLIP_KIND, fmtDuration, mediaUrl, speakerColor, useNav } from "../nav";

const STATUS: Record<MeetingRecord["status"], { label: string; tone: "neutral" | "accent" | "cloud" }> = {
  recording: { label: "recording", tone: "cloud" },
  processing: { label: "processing", tone: "accent" },
  ready: { label: "ready", tone: "neutral" },
  failed: { label: "failed", tone: "cloud" },
};

export function MeetingsPage({ initialId, at }: { initialId?: string; at?: number }) {
  const [list, setList] = useState<MeetingRecord[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [dragging, setDragging] = useState(false);
  const [askAll, setAskAll] = useState(false);

  const load = useCallback(() => void window.vd.invoke("meetings:list", { query }).then(setList), [query]);
  useEffect(() => {
    const t = setTimeout(load, 120);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => window.vd.on("meetings:changed", load), [load]);
  useEffect(() => {
    if (!selected && list[0]) setSelected(list[0].id);
  }, [list, selected]);

  const start = async (kind: "call" | "room") => {
    const s = await window.vd.invoke("meetings:start", { kind });
    setSelected(s.id);
    load();
  };

  return (
    <div
      className="flex h-full"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const paths = [...e.dataTransfer.files].map((f) => window.vd.pathForFile(f)).filter(Boolean);
        if (paths.length) void window.vd.invoke("meetings:import", paths).then((ids) => ids[0] && setSelected(ids[0]));
      }}
    >
      <aside className="flex w-80 shrink-0 flex-col border-r border-line">
        <div className="space-y-2 border-b border-line p-3">
          <div className="flex gap-1.5">
            <Button variant="primary" className="flex-1" onClick={() => void start("call")} title="Records your mic and the call's audio as separate tracks">
              Record call
            </Button>
            <Button className="flex-1" onClick={() => void start("room")} title="Records only the mic and separates everyone by voice">
              In person
            </Button>
          </div>
          <div className="flex gap-1.5">
            <Button className="flex-1" onClick={() => void window.vd.invoke("meetings:import").then((ids) => ids[0] && setSelected(ids[0]))}>
              Import files…
            </Button>
            <Button className="flex-1" onClick={() => setAskAll((v) => !v)} aria-pressed={askAll}>
              Ask all meetings
            </Button>
          </div>
          <Input type="search" placeholder="Search meetings…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search meetings" />
        </div>
        <ul className="flex-1 overflow-y-auto p-2">
          {list.length === 0 && <li className="p-4 text-center text-sm text-fg-muted">No meetings yet. Record one, or drop audio/video files here.</li>}
          {list.map((m) => (
            <li key={m.id}>
              <button
                onClick={() => {
                  setSelected(m.id);
                  setAskAll(false);
                }}
                className={cx("w-full rounded-md px-3 py-2 text-left", selected === m.id && !askAll ? "bg-muted" : "hover:bg-muted/60")}
              >
                <div className="truncate text-sm font-medium">{m.title}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-muted">
                  {new Date(m.startedAt).toLocaleDateString()} · {fmtDuration(m.durationMs)}
                  {m.status !== "ready" && <Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>}
                  {m.kind !== "call" && <Badge>{m.kind === "room" ? "in person" : "import"}</Badge>}
                </div>
              </button>
            </li>
          ))}
        </ul>
        {dragging && <div className="pointer-events-none border-t border-accent bg-accent/10 p-3 text-center text-sm">Drop to import</div>}
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">
        {askAll ? <AskBox meetingId={null} /> : selected ? <MeetingView key={selected} id={selected} at={selected === initialId ? at : undefined} /> : null}
      </section>
    </div>
  );
}

function MeetingView({ id, at }: { id: string; at?: number }) {
  const [d, setD] = useState<MeetingDetail | null>(null);
  const [tab, setTab] = useState<"summary" | "transcript" | "ask">("transcript");
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const nav = useNav();
  // The transcript line under the playhead, and whether to keep it in view.
  const [playing, setPlaying] = useState<{ lineId: string | null; follow: boolean }>({ lineId: null, follow: false });

  const load = useCallback(() => void window.vd.invoke("meetings:get", id).then(setD), [id]);
  useEffect(load, [load]);
  useEffect(() => window.vd.on("meetings:changed", load), [load]);
  useEffect(
    () =>
      window.vd.on("meeting:progress", (mid, text) => {
        if (mid === id) setProgress(text);
      }),
    [id],
  );
  useEffect(
    () =>
      window.vd.on("meeting:line", (mid) => {
        if (mid === id) load();
      }),
    [id, load],
  );
  useEffect(() => {
    if (d?.meeting.summary && tab === "transcript" && at === undefined) setTab("summary");
    // only on first load of a summarized meeting
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.meeting.id]);

  if (!d) return null;
  const m = d.meeting;
  const names = Object.fromEntries(d.speakers.map((s) => [s.key, s.name]));
  const track = (a: HTMLAudioElement) => {
    const ms = a.currentTime * 1000;
    let cur: TranscriptLine | null = null;
    for (const l of d.lines) if (l.start <= ms && (!cur || l.start >= cur.start)) cur = l;
    const next = { lineId: cur?.id ?? null, follow: !a.paused };
    if (next.lineId !== playing.lineId || next.follow !== playing.follow) setPlaying(next);
  };
  const seek = (ms: number) => {
    if (audio.current) {
      audio.current.currentTime = ms / 1000;
      void audio.current.play();
    }
  };
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      alert((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <input
            className="w-full bg-transparent text-xl font-semibold outline-none focus:underline"
            defaultValue={m.title}
            aria-label="Meeting title"
            onBlur={(e) => e.target.value !== m.title && void window.vd.invoke("meetings:rename", id, e.target.value)}
          />
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            {new Date(m.startedAt).toLocaleString()} · {fmtDuration(m.durationMs)}
            {m.sourceApp && <Badge>{m.sourceApp}</Badge>}
            {m.kind !== "call" && <Badge>{m.kind === "room" ? "in person" : "imported"}</Badge>}
            {m.recovered && <Badge tone="cloud">recovered after a crash</Badge>}
            {m.attendees.length > 0 && <span>with {m.attendees.join(", ")}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {m.status === "recording" && (
            <Button variant="danger" onClick={() => void window.vd.invoke("meetings:stop", "meetings page")}>
              Stop recording
            </Button>
          )}
          <ExportMenu id={id} disabled={m.status !== "ready"} />
          {(m.status === "ready" || m.status === "failed") && (
            <Button
              disabled={!!busy}
              title="Use a transcript from Meet, Teams, Zoom, Otter, Supernormal, subtitles, Word or text, and summarize it"
              onClick={() => {
                if (d.lines.length && !confirm("Replace this meeting's transcript with the one in the file?")) return;
                void run("Importing…", async () => {
                  if (await window.vd.invoke("meetings:importTranscript", id)) setTab("summary");
                });
              }}
            >
              {busy === "Importing…" ? busy : "Import transcript…"}
            </Button>
          )}
          <Button onClick={() => void window.vd.invoke("meetings:toNote", id).then((n) => nav({ tab: "notes", noteId: n.id }))} disabled={m.status !== "ready"}>
            Make note
          </Button>
        </div>
      </header>

      {(m.status === "processing" || m.status === "failed") && (
        <div className={cx("mt-4 rounded-md border border-line p-3 text-sm", m.status === "failed" ? "text-warn" : "")}>
          {m.status === "processing" ? `Processing… ${progress}` : `Processing failed: ${m.error}`}
          {m.status === "failed" && (
            <Button className="ml-3 h-7" onClick={() => void window.vd.invoke("meetings:reprocess", id)}>
              Try again
            </Button>
          )}
        </div>
      )}

      {m.audioFile && (
        // Pinned while the transcript scrolls along with playback.
        <div className="sticky top-0 z-10 bg-bg pt-4">
          <audio
            ref={audio}
            controls
            preload="metadata"
            src={mediaUrl(id)}
            className="w-full"
            aria-label="Meeting recording"
            onTimeUpdate={(e) => track(e.currentTarget)}
            onSeeked={(e) => track(e.currentTarget)}
            onPlay={(e) => track(e.currentTarget)}
            onPause={(e) => track(e.currentTarget)}
          />
        </div>
      )}

      {d.clips.length > 0 && <ScreenClips meetingId={id} clips={d.clips} audio={audio} />}

      <div className="mt-4 flex gap-1 border-b border-line" role="tablist">
        {(["summary", "transcript", "ask"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cx("-mb-px border-b-2 px-3 py-2 text-sm capitalize", tab === t ? "border-accent font-medium" : "border-transparent text-fg-muted")}
          >
            {t === "ask" ? "Ask" : t}
          </button>
        ))}
      </div>

      {tab === "summary" && (
        <div className="py-4">
          {m.summary ? (
            <SummaryView s={m.summary} />
          ) : (
            <p className="text-sm text-fg-muted">{m.status === "ready" ? "No summary yet." : "The summary is made after processing."}</p>
          )}
          {m.status === "ready" && (
            <Button className="mt-4" disabled={!!busy} onClick={() => void run("Summarizing…", () => window.vd.invoke("meetings:summarize", id))}>
              {busy || (m.summary ? "Summarize again" : "Summarize")}
            </Button>
          )}
        </div>
      )}

      {tab === "transcript" && (
        <div className="grid gap-6 py-4 lg:grid-cols-[1fr_220px]">
          <Transcript meetingId={id} lines={d.lines} names={names} speakers={d.speakers} onSeek={m.audioFile ? seek : undefined} highlightAt={at} playing={playing} />
          <SpeakersPanel id={id} d={d} />
        </div>
      )}

      {tab === "ask" && <AskBox meetingId={id} />}

      {m.status === "ready" && (
        <footer className="mt-8 flex flex-wrap gap-2 border-t border-line pt-4">
          {m.audioFile && (
            <Button
              variant="ghost"
              onClick={() =>
                (!d.lines.length || confirm("Re-process makes a new transcript from the audio, replacing the current one (including an imported one). Continue?")) &&
                void window.vd.invoke("meetings:reprocess", id)
              }
            >
              Re-process (re-detect speakers)
            </Button>
          )}
          {m.audioFile && (
            <Button variant="ghost" onClick={() => confirm("Delete this meeting's audio? The transcript is kept.") && void window.vd.invoke("meetings:deleteAudio", id)}>
              Delete audio
            </Button>
          )}
          <Button variant="danger" onClick={() => confirm("Delete this meeting, its audio and transcript?") && void window.vd.invoke("meetings:delete", id)}>
            Delete meeting
          </Button>
        </footer>
      )}
    </div>
  );
}

function SummaryView({ s }: { s: NonNullable<MeetingRecord["summary"]> }) {
  const Section = ({ title, items }: { title: string; items: string[] }) => (
    <section className="mb-5">
      <h3 className="mb-1.5 text-sm font-semibold">{title}</h3>
      {items.length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">None</p>
      )}
    </section>
  );
  return (
    <div>
      {s.topics?.length ? (
        // Detailed notes already cover the key points and decisions; don't repeat them.
        s.topics.map((t, i) => (
          <section key={i} className="mb-6">
            <h3 className="mb-2 text-base font-semibold">{t.heading}</h3>
            {t.sections.map((sec, j) => (
              <div key={j} className="mb-3">
                <h4 className="mb-1 text-sm font-semibold text-fg-muted">{sec.heading}</h4>
                <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
                  {sec.points.map((p, k) => (
                    <li key={k}>{p}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))
      ) : (
        <>
          <Section title="Key points" items={s.keyPoints} />
          <Section title="Decisions" items={s.decisions} />
        </>
      )}
      <section className="mb-5">
        <h3 className="mb-1.5 text-sm font-semibold">Action items</h3>
        {s.actionItems.length ? (
          <ul className="space-y-1.5 text-sm">
            {s.actionItems.map((a, i) => (
              <li key={i} className="flex gap-2">
                <input type="checkbox" aria-label={a.task} className="mt-1" />
                <span>
                  {a.task}
                  {a.owner && <span className="ml-1.5"><Badge tone="accent">{a.owner}</Badge></span>}
                  {a.due && <span className="ml-1 text-xs text-fg-muted">due {a.due}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">None</p>
        )}
      </section>
      <Section title="Open questions" items={s.openQuestions} />
    </div>
  );
}

function Transcript({
  meetingId,
  lines,
  names,
  speakers,
  onSeek,
  highlightAt,
  playing,
}: {
  meetingId: string;
  lines: TranscriptLine[];
  names: Record<string, string>;
  speakers: MeetingDetail["speakers"];
  onSeek?: (ms: number) => void;
  highlightAt?: number;
  playing?: { lineId: string | null; follow: boolean };
}) {
  const ref = useRef<HTMLOListElement>(null);
  // Scrolling by hand pauses following for a few seconds, so reading back isn't yanked away.
  const handScrolled = useRef(0);
  useEffect(() => {
    const mark = () => (handScrolled.current = Date.now());
    window.addEventListener("wheel", mark, { passive: true });
    window.addEventListener("touchmove", mark, { passive: true });
    return () => {
      window.removeEventListener("wheel", mark);
      window.removeEventListener("touchmove", mark);
    };
  }, []);
  useEffect(() => {
    if (!playing?.follow || !playing.lineId || Date.now() - handScrolled.current < 4000) return;
    ref.current?.querySelector(`[data-id="${playing.lineId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [playing?.lineId, playing?.follow]);
  useEffect(() => {
    if (highlightAt === undefined) return;
    ref.current?.querySelector(`[data-at="${lines.find((l) => l.start >= highlightAt - 2000)?.start}"]`)?.scrollIntoView({ block: "center" });
  }, [highlightAt, lines]);
  if (!lines.length) return <p className="text-sm text-fg-muted">No transcript yet.</p>;
  return (
    <ol ref={ref} className="space-y-3">
      {lines.map((l) => (
        <li
          key={l.id}
          data-at={l.start}
          data-id={l.id}
          aria-current={playing?.lineId === l.id || undefined}
          className={cx(
            "group rounded transition-colors",
            ((highlightAt !== undefined && Math.abs(l.start - highlightAt) < 2000) || playing?.lineId === l.id) && "bg-accent/10",
            playing?.lineId === l.id && "-mx-2 px-2 py-1",
          )}
        >
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold" style={{ color: speakerColor(l.speakerKey) }}>
              {names[l.speakerKey] ?? (l.speakerKey === "others" ? "Others" : l.speakerKey === "room" ? "Speaker" : "Unknown")}
            </span>
            <button className="text-fg-muted hover:underline disabled:no-underline" disabled={!onSeek} onClick={() => onSeek?.(l.start)}>
              {clock(l.start)}
            </button>
            {l.overlap && <Badge tone="cloud">overlap</Badge>}
            {l.uncertainSpeaker && <Badge tone="cloud">speaker?</Badge>}
            {l.conf < 0.6 && <Badge>low confidence</Badge>}
            {speakers.length > 1 && (
              <select
                className="ml-auto hidden rounded border border-line bg-panel text-xs group-hover:block"
                value={l.speakerKey}
                aria-label="Change speaker for this line"
                onChange={(e) => void window.vd.invoke("meetings:setLineSpeaker", meetingId, l.id, e.target.value)}
              >
                {speakers.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <p className="text-sm leading-relaxed">{l.text}</p>
        </li>
      ))}
    </ol>
  );
}

function SpeakersPanel({ id, d }: { id: string; d: MeetingDetail }) {
  return (
    <aside className="space-y-3">
      <h3 className="text-sm font-semibold">Speakers</h3>
      <datalist id={`people-${id}`}>
        {d.suggestions.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {d.speakers.map((s) => (
        <div key={s.key} className="rounded-md border border-line p-2">
          <div className="flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ background: speakerColor(s.key) }} />
            <input
              list={`people-${id}`}
              defaultValue={s.name}
              disabled={s.key === "me"}
              aria-label={`Name for ${s.name}`}
              className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none focus:underline"
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && void window.vd.invoke("meetings:renameSpeaker", id, s.key, e.target.value)}
            />
          </div>
          <div className="mt-1 text-[11px] text-fg-muted">
            {s.key === "me"
              ? "Your microphone"
              : s.confirmed
                ? "Named by you · voice saved"
                : s.personId
                  ? `Recognized by voice · ${s.confidence} confidence (${Math.round((s.score ?? 0) * 100)}%)`
                  : /^t\d+$/.test(s.key)
                    ? "From the imported transcript"
                    : "Unknown voice — type a name to remember it"}
          </div>
        </div>
      ))}
    </aside>
  );
}

function ExportMenu({ id, disabled }: { id: string; disabled: boolean }) {
  const [msg, setMsg] = useState("");
  return (
    <div className="flex items-center gap-1">
      <select
        className="h-8 rounded-md border border-line bg-panel px-2 text-sm"
        disabled={disabled}
        value=""
        aria-label="Export"
        onChange={async (e) => {
          const f = e.target.value as ExportFormat;
          if (!f) return;
          const path = await window.vd.invoke("meetings:export", id, f);
          if (path) {
            setMsg("Saved");
            setTimeout(() => setMsg(""), 2000);
          }
        }}
      >
        <option value="">Export…</option>
        <option value="md">Markdown (.md)</option>
        <option value="txt">Text (.txt)</option>
        <option value="docx">Word (.docx)</option>
        <option value="srt">Subtitles (.srt)</option>
        <option value="vtt">Subtitles (.vtt)</option>
      </select>
      {msg && <span className="text-xs text-fg-muted">{msg}</span>}
    </div>
  );
}

function AskBox({ meetingId }: { meetingId: string | null }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Array<{ q: string; a: string; cloud: boolean }>>([]);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await window.vd.invoke("meetings:ask", meetingId, q.trim());
      setItems((x) => [...x, { q: q.trim(), a: r.answer, cloud: r.cloud }]);
      setQ("");
    } catch (e) {
      setItems((x) => [...x, { q: q.trim(), a: `⚠ ${(e as Error).message}`, cloud: false }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-3xl p-6">
      {!meetingId && <h2 className="mb-1 text-lg font-semibold">Ask across all meetings</h2>}
      <p className="mb-4 text-sm text-fg-muted">
        {meetingId ? "Questions are answered from this meeting's transcript." : "e.g. “What did we decide about pricing last week?”"}
      </p>
      <div className="space-y-4">
        {items.map((it, i) => (
          <div key={i}>
            <p className="text-sm font-medium">{it.q}</p>
            <div className="mt-1 rounded-md border border-line bg-panel p-3 text-sm">
              <Markdown text={it.a} />
              {it.cloud && <Badge tone="cloud">answered by your cloud model</Badge>}
            </div>
          </div>
        ))}
      </div>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask a question…" aria-label="Question" />
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Thinking…" : "Ask"}
        </Button>
      </form>
    </div>
  );
}


/**
 * Screen recordings made during the meeting. Playing a clip also plays the meeting audio from
 * the same moment, so you hear what was said while it was on screen.
 */
function ScreenClips({ meetingId, clips, audio }: { meetingId: string; clips: ClipRecord[]; audio: React.RefObject<HTMLAudioElement | null> }) {
  const [open, setOpen] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const nav = useNav();
  const edit = async (clipId: string) => {
    const p = await window.vd.invoke("video:create", meetingId, [clipId]);
    nav({ tab: "library", projectId: p.id });
  };
  // Served by the app's local media server, which supports byte ranges for seeking.
  const src = open ? mediaUrl(meetingId, open) : undefined;

  const clip = clips.find((c) => c.id === open);
  const sync = () => {
    const v = video.current;
    const a = audio.current;
    if (!v || !a || !clip) return;
    a.currentTime = clip.startMs / 1000 + v.currentTime;
    if (v.paused) a.pause();
    else void a.play();
  };

  return (
    <section className="mt-4 rounded-lg border border-line p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Screen recordings</h3>
        <Button variant="ghost" className="h-7 px-2" onClick={() => nav({ tab: "library" })}>
          {clips.filter((c) => c.file).length > 1 ? "Edit or merge in Video library" : "Open Video library"}
        </Button>
      </div>
      <ul className="space-y-1.5">
        {clips.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-sm">
            <Button variant={open === c.id ? "primary" : "secondary"} className="h-7 px-2" disabled={!c.file} onClick={() => setOpen(open === c.id ? null : c.id)}>
              {open === c.id ? "Close" : "Play"}
            </Button>
            <span className="tabular-nums text-fg-muted">{clock(c.startMs)}</span>
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
            <Badge>{CLIP_KIND[c.kind]}</Badge>
            <span className="tabular-nums text-xs text-fg-muted">{c.endMs !== null ? clock(c.endMs - c.startMs) : "–"}</span>
            {!c.file && <span className="text-xs text-fg-muted">deleted</span>}
            {c.file && c.endMs !== null && (
              <Button variant="ghost" className="h-7 px-2" onClick={() => void edit(c.id)}>
                Edit
              </Button>
            )}
            <Button
              variant="ghost"
              className="h-7 px-2"
              onClick={() => confirm("Delete this screen recording?") && void window.vd.invoke("clips:delete", c.id).then(() => open === c.id && setOpen(null))}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
      {open && (
        <video
          ref={video}
          src={src}
          controls
          className="mt-3 w-full rounded bg-black"
          onPlay={sync}
          onPause={sync}
          onSeeked={sync}
          aria-label="Screen recording"
        />
      )}
    </section>
  );
}
