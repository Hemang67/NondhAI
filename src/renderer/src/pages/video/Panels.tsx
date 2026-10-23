import { useState } from "react";
import type { VideoProgress, VideoProjectDetail } from "@shared/ipc";
import { clipRef, linesOnTimeline, newId, type BlurBox, type ProjectSpec, type TimedRange } from "@shared/video/project";
import { Badge, Button, cx, Input, Switch } from "../../components/ui";
import { clock, speakerColor } from "../../nav";
import type { DrawMode, Selection } from "./Preview";

export type PanelTab = "crop" | "blur" | "text" | "media" | "subtitles" | "transcript";

interface Ctx {
  spec: ProjectSpec;
  detail: VideoProjectDetail;
  t: number;
  total: number;
  base: { width: number; height: number };
  update: (fn: (s: ProjectSpec) => ProjectSpec, key?: string) => void;
  selection: Selection;
  select: (s: Selection) => void;
  seek: (t: number) => void;
  draw: DrawMode;
  setDraw: (d: DrawMode) => void;
}

const round = (v: number) => Math.round(v * 10) / 10;

/** Start/end inputs for anything shown for part of the video. */
function Times({ item, total, t, onChange }: { item: TimedRange; total: number; t: number; onChange: (r: TimedRange) => void }) {
  const field = (which: "start" | "end") => (
    <label className="flex items-center gap-1">
      <span className="w-9 text-fg-muted">{which === "start" ? "From" : "To"}</span>
      <Input
        type="number"
        step="0.1"
        min={0}
        max={total}
        className="h-7 w-20 tabular-nums"
        value={round(item[which])}
        onChange={(e) => {
          const v = Math.max(0, Math.min(total, Number(e.target.value)));
          if (Number.isFinite(v)) onChange(which === "start" ? { start: Math.min(v, item.end - 0.1), end: item.end } : { start: item.start, end: Math.max(v, item.start + 0.1) });
        }}
      />
      <Button
        variant="ghost"
        className="h-7 px-1.5 text-xs"
        title="Use the playhead position"
        onClick={() => onChange(which === "start" ? { start: Math.min(t, item.end - 0.1), end: item.end } : { start: item.start, end: Math.max(t, item.start + 0.1) })}
      >
        ⤓ {clock(t * 1000)}
      </Button>
    </label>
  );
  return (
    <div className="space-y-1.5 text-xs">
      {field("start")}
      {field("end")}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-16 text-fg-muted">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1 accent-[var(--accent)]" />
      <span className="w-10 text-right tabular-nums">{format ? format(value) : value}</span>
    </label>
  );
}

function Item({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <li>
      <button onClick={onClick} className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs", selected ? "bg-accent/15" : "hover:bg-muted")}>
        {children}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------- crop

export function CropPanel({ spec, base, update, draw, setDraw }: Ctx) {
  const preset = (ratio: number) => {
    const frame = base.width / base.height;
    const w = ratio > frame ? 1 : ratio / frame;
    const h = ratio > frame ? frame / ratio : 1;
    update((s) => ({ ...s, crop: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } }));
  };
  const c = spec.crop;
  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted">Keep only part of the picture. The crop applies to the whole video.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant={draw === "crop" ? "primary" : "secondary"} onClick={() => setDraw(draw === "crop" ? null : "crop")}>
          {draw === "crop" ? "Cancel drawing" : c ? "Draw a new crop" : "Draw crop area"}
        </Button>
        {c && (
          <Button variant="ghost" onClick={() => update((s) => ({ ...s, crop: null }))}>
            Remove crop
          </Button>
        )}
      </div>
      <div>
        <div className="mb-1 text-xs text-fg-muted">Centered shapes</div>
        <div className="flex flex-wrap gap-1.5">
          {([["16:9", 16 / 9], ["4:3", 4 / 3], ["1:1", 1], ["9:16", 9 / 16]] as const).map(([l, r]) => (
            <Button key={l} className="h-7 px-2 text-xs" onClick={() => preset(r)}>
              {l}
            </Button>
          ))}
        </div>
      </div>
      {c && (
        <p className="text-xs text-fg-muted">
          Output size: {Math.round(base.width * c.w)} × {Math.round(base.height * c.h)} px (from {base.width} × {base.height})
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- blur & sensitive info

/** Shows enough of a detected secret to recognize it, without putting it back on screen. */
const redact = (s: string) => (s.length <= 4 ? "••••" : `${s.slice(0, 2)}${"•".repeat(Math.min(8, s.length - 4))}${s.slice(-2)}`);

export function BlurPanel(c: Ctx & { scan: VideoProgress | undefined; onScan: () => void; onCancelScan: () => void; scanError: string | null; scanned: number | null }) {
  const { spec, update, selection, select, t, total, draw, setDraw, seek } = c;
  const suggested = spec.blurs.filter((b) => b.suggested);
  const accepted = spec.blurs.filter((b) => !b.suggested);
  const sel = spec.blurs.find((b) => selection?.kind === "blur" && b.id === selection.id);
  const scanning = c.scan?.phase === "scanning";
  const setBlur = (id: string, patch: Partial<BlurBox>, key?: string) =>
    update((s) => ({ ...s, blurs: s.blurs.map((b) => (b.id === id ? { ...b, ...patch } : b)) }), key);
  const accept = (ids: string[]) =>
    update((s) => ({ ...s, blurs: s.blurs.map((b) => (ids.includes(b.id) ? { ...b, suggested: undefined } : b)) }));
  const dismiss = (ids: string[]) => update((s) => ({ ...s, blurs: s.blurs.filter((b) => !ids.includes(b.id)) }));

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-line p-3">
        <h3 className="text-sm font-semibold">Hide sensitive information</h3>
        <p className="mt-1 text-xs text-fg-muted">
          Reads the text on screen (on this computer, with Windows text recognition) and suggests blurs over passwords, API keys, tokens and card numbers. Review
          each suggestion — only accepted blurs go into the export.
        </p>
        <div className="mt-2 flex items-center gap-2">
          {scanning ? (
            <>
              <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                <div className="h-full bg-accent transition-all" style={{ width: `${Math.round((c.scan?.fraction ?? 0) * 100)}%` }} />
              </div>
              <Button variant="ghost" className="h-7 px-2" onClick={c.onCancelScan}>
                Stop
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={c.onScan}>
              Find sensitive info
            </Button>
          )}
        </div>
        {c.scanError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{c.scanError}</p>}
        {c.scanned !== null && !scanning && !c.scanError && (
          <p className="mt-2 text-xs text-fg-muted">{c.scanned ? `Found ${c.scanned} thing${c.scanned === 1 ? "" : "s"} to review.` : "Nothing new found. Text recognition can miss things, so check the video yourself too."}</p>
        )}
        {suggested.length > 0 && (
          <>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs font-medium">To review ({suggested.length})</span>
              <span className="flex gap-1">
                <Button className="h-6 px-2 text-xs" variant="primary" onClick={() => accept(suggested.map((b) => b.id))}>
                  Blur all
                </Button>
                <Button className="h-6 px-2 text-xs" variant="ghost" onClick={() => dismiss(suggested.map((b) => b.id))}>
                  Dismiss all
                </Button>
              </span>
            </div>
            <ul className="mt-1 space-y-1">
              {suggested.map((b) => (
                <li key={b.id} className={cx("flex items-center gap-2 rounded-md px-2 py-1 text-xs", selection?.id === b.id ? "bg-amber-500/15" : "bg-muted")}>
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      select({ kind: "blur", id: b.id });
                      seek(b.start + 0.05);
                    }}
                  >
                    <div className="truncate font-medium">{b.suggested!.reason}</div>
                    <div className="truncate font-mono text-fg-muted">
                      {redact(b.suggested!.text)} · {clock(b.start * 1000)}–{clock(b.end * 1000)}
                    </div>
                  </button>
                  <Button className="h-6 px-2 text-xs" onClick={() => accept([b.id])}>
                    Blur
                  </Button>
                  <Button className="h-6 px-2 text-xs" variant="ghost" onClick={() => dismiss([b.id])}>
                    Dismiss
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Blur boxes</h3>
          <Button variant={draw === "blur" ? "primary" : "secondary"} className="h-7 px-2" onClick={() => setDraw(draw === "blur" ? null : "blur")}>
            {draw === "blur" ? "Cancel" : "+ Draw blur"}
          </Button>
        </div>
        <p className="mt-1 text-xs text-fg-muted">Draw over the picture. A new blur lasts from the playhead to the end; adjust it below or on the timeline.</p>
        <ul className="mt-2 space-y-0.5">
          {accepted.map((b, i) => (
            <Item
              key={b.id}
              selected={selection?.id === b.id}
              onClick={() => {
                select({ kind: "blur", id: b.id });
                if (t < b.start || t >= b.end) seek(b.start + 0.05);
              }}
            >
              <span className="flex-1">Blur {i + 1}</span>
              <span className="tabular-nums text-fg-muted">
                {clock(b.start * 1000)}–{clock(b.end * 1000)}
              </span>
            </Item>
          ))}
        </ul>
      </section>

      {sel && (
        <section className="space-y-2 rounded-md border border-line p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Selected blur{sel.suggested && <Badge tone="cloud">suggested</Badge>}</h3>
            <Button variant="ghost" className="h-7 px-2 text-red-600 dark:text-red-400" onClick={() => dismiss([sel.id])}>
              Remove
            </Button>
          </div>
          <Times item={sel} total={total} t={t} onChange={(r) => setBlur(sel.id, r)} />
          <Slider label="Strength" value={sel.strength} min={4} max={40} step={1} onChange={(v) => setBlur(sel.id, { strength: v }, `strength-${sel.id}`)} />
          <Button className="h-7 px-2 text-xs" onClick={() => setBlur(sel.id, { start: 0, end: total })}>
            Blur for the whole video
          </Button>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- text

const COLORS = ["#ffffff", "#ffcc00", "#ff4d4f", "#22c55e", "#38bdf8", "#000000"];

export function TextPanel({ spec, update, selection, select, t, total, seek }: Ctx) {
  const sel = spec.texts.find((x) => selection?.kind === "text" && x.id === selection.id);
  const set = (id: string, patch: Partial<ProjectSpec["texts"][number]>, key?: string) =>
    update((s) => ({ ...s, texts: s.texts.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), key);
  const add = () => {
    const id = newId("x");
    update((s) => ({
      ...s,
      texts: [...s.texts, { id, text: "Your text", x: 0.05, y: 0.08, size: 0.06, color: "#ffffff", background: true, start: t, end: Math.min(total, t + 4) }],
    }));
    select({ kind: "text", id });
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Text</h3>
        <Button className="h-7 px-2" onClick={add}>
          + Add text
        </Button>
      </div>
      <p className="text-xs text-fg-muted">Titles, labels or callouts. Drag the text on the picture to place it.</p>
      <ul className="space-y-0.5">
        {spec.texts.map((x) => (
          <Item
            key={x.id}
            selected={selection?.id === x.id}
            onClick={() => {
              select({ kind: "text", id: x.id });
              if (t < x.start || t >= x.end) seek(x.start + 0.05);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{x.text || "(empty)"}</span>
            <span className="tabular-nums text-fg-muted">{clock(x.start * 1000)}</span>
          </Item>
        ))}
      </ul>
      {sel && (
        <section className="space-y-2 rounded-md border border-line p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Selected text</h3>
            <Button variant="ghost" className="h-7 px-2 text-red-600 dark:text-red-400" onClick={() => update((s) => ({ ...s, texts: s.texts.filter((x) => x.id !== sel.id) }))}>
              Remove
            </Button>
          </div>
          <textarea
            aria-label="Text"
            className="w-full rounded-md border border-line bg-panel p-2 text-sm focus:border-accent focus:outline-none"
            rows={2}
            value={sel.text}
            onChange={(e) => set(sel.id, { text: e.target.value }, `text-${sel.id}`)}
          />
          <Slider label="Size" value={Math.round(sel.size * 100)} min={2} max={20} step={1} onChange={(v) => set(sel.id, { size: v / 100 }, `size-${sel.id}`)} />
          <div className="flex items-center gap-1.5 text-xs">
            <span className="w-16 text-fg-muted">Color</span>
            {COLORS.map((col) => (
              <button
                key={col}
                aria-label={`Color ${col}`}
                className={cx("size-5 rounded-full border border-line", sel.color === col && "ring-2 ring-accent ring-offset-1")}
                style={{ background: col }}
                onClick={() => set(sel.id, { color: col })}
              />
            ))}
            <input type="color" aria-label="Custom color" value={sel.color} onChange={(e) => set(sel.id, { color: e.target.value }, `color-${sel.id}`)} className="h-5 w-6" />
          </div>
          <label className="flex items-center justify-between text-xs">
            <span className="text-fg-muted">Dark box behind text</span>
            <Switch checked={sel.background} onChange={(v) => set(sel.id, { background: v })} label="Dark box behind text" />
          </label>
          <Times item={sel} total={total} t={t} onChange={(r) => set(sel.id, r)} />
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- images & audio

export function MediaPanel(c: Ctx & { trackLengths: Record<string, number> }) {
  const { spec, update, selection, select, t, total, detail, seek } = c;
  const soundLabel = detail.source === "library" ? "Original sound" : "Meeting audio";
  const [error, setError] = useState<string | null>(null);
  const sel = spec.images.find((x) => selection?.kind === "image" && x.id === selection.id);
  const pick = async (kind: "image" | "audio") => {
    setError(null);
    try {
      const a = await window.vd.invoke("video:pickAsset", detail.project.id, kind);
      if (!a) return;
      const id = newId(kind === "image" ? "i" : "a");
      if (kind === "image") {
        update((s) => ({ ...s, images: [...s.images, { id, file: a.file, x: 0.75, y: 0.05, w: 0.2, start: t, end: total }] }));
        select({ kind: "image", id });
      } else {
        update((s) => ({ ...s, audioTracks: [...s.audioTracks, { id, file: a.file, start: t, volume: 0.6 }] }));
        select({ kind: "track", id });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Images</h3>
          <Button className="h-7 px-2" onClick={() => void pick("image")}>
            + Add image
          </Button>
        </div>
        <p className="text-xs text-fg-muted">A logo, an arrow, a sticker. Drag on the picture to move; drag the corner to resize.</p>
        <ul className="space-y-0.5">
          {spec.images.map((x, i) => (
            <Item
              key={x.id}
              selected={selection?.id === x.id}
              onClick={() => {
                select({ kind: "image", id: x.id });
                if (t < x.start || t >= x.end) seek(x.start + 0.05);
              }}
            >
              <span className="flex-1">Image {i + 1}</span>
              <span className="tabular-nums text-fg-muted">
                {clock(x.start * 1000)}–{clock(x.end * 1000)}
              </span>
            </Item>
          ))}
        </ul>
        {sel && (
          <div className="space-y-2 rounded-md border border-line p-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">Selected image</h4>
              <Button variant="ghost" className="h-7 px-2 text-red-600 dark:text-red-400" onClick={() => update((s) => ({ ...s, images: s.images.filter((x) => x.id !== sel.id) }))}>
                Remove
              </Button>
            </div>
            <Slider
              label="Width"
              value={Math.round(sel.w * 100)}
              min={3}
              max={100}
              step={1}
              format={(v) => `${v}%`}
              onChange={(v) => update((s) => ({ ...s, images: s.images.map((x) => (x.id === sel.id ? { ...x, w: v / 100 } : x)) }), `imgw-${sel.id}`)}
            />
            <Times item={sel} total={total} t={t} onChange={(r) => update((s) => ({ ...s, images: s.images.map((x) => (x.id === sel.id ? { ...x, ...r } : x)) }))} />
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Sound</h3>
        <div className="space-y-2 rounded-md border border-line p-3">
          <label className="flex items-center justify-between text-xs">
            <span>
              {soundLabel}
              {!detail.meeting.hasAudio && <span className="text-fg-muted"> ({detail.source === "library" ? "none in this video" : "deleted"})</span>}
            </span>
            <Switch
              checked={spec.meetingAudio.enabled && detail.meeting.hasAudio}
              onChange={(v) => update((s) => ({ ...s, meetingAudio: { ...s.meetingAudio, enabled: v } }))}
              label={soundLabel}
            />
          </label>
          {spec.meetingAudio.enabled && detail.meeting.hasAudio && (
            <Slider
              label="Volume"
              value={Math.round(spec.meetingAudio.volume * 100)}
              min={0}
              max={200}
              step={5}
              format={(v) => `${v}%`}
              onChange={(v) => update((s) => ({ ...s, meetingAudio: { ...s.meetingAudio, volume: v / 100 } }), "meeting-volume")}
            />
          )}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-fg-muted">Music or voice-over, starting at the playhead.</span>
          <Button className="h-7 px-2" onClick={() => void pick("audio")}>
            + Add audio
          </Button>
        </div>
        {spec.audioTracks.map((a, i) => (
          <div key={a.id} className={cx("space-y-2 rounded-md border p-3", selection?.id === a.id ? "border-accent" : "border-line")}>
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">
                Audio {i + 1} <span className="font-normal text-fg-muted">· {clock((c.trackLengths[a.id] ?? 0) * 1000)} long</span>
              </span>
              <Button variant="ghost" className="h-6 px-2 text-xs text-red-600 dark:text-red-400" onClick={() => update((s) => ({ ...s, audioTracks: s.audioTracks.filter((x) => x.id !== a.id) }))}>
                Remove
              </Button>
            </div>
            <label className="flex items-center gap-1 text-xs">
              <span className="w-16 text-fg-muted">Starts at</span>
              <Input
                type="number"
                step="0.1"
                min={0}
                className="h-7 w-20"
                value={round(a.start)}
                onChange={(e) =>
                  update((s) => ({ ...s, audioTracks: s.audioTracks.map((x) => (x.id === a.id ? { ...x, start: Math.max(0, Number(e.target.value) || 0) } : x)) }), `track-start-${a.id}`)
                }
              />
              <Button variant="ghost" className="h-7 px-1.5 text-xs" onClick={() => update((s) => ({ ...s, audioTracks: s.audioTracks.map((x) => (x.id === a.id ? { ...x, start: t } : x)) }))}>
                ⤓ {clock(t * 1000)}
              </Button>
            </label>
            <Slider
              label="Volume"
              value={Math.round(a.volume * 100)}
              min={0}
              max={200}
              step={5}
              format={(v) => `${v}%`}
              onChange={(v) => update((s) => ({ ...s, audioTracks: s.audioTracks.map((x) => (x.id === a.id ? { ...x, volume: v / 100 } : x)) }), `track-vol-${a.id}`)}
            />
          </div>
        ))}
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- subtitles

export function SubtitlesPanel({ spec, update, selection, select, t, total, seek, detail, live }: Ctx & { live?: VideoProgress }) {
  const subs = spec.subtitles;
  const [speechError, setSpeechError] = useState<string | null>(null);
  const transcribing = live?.phase === "transcribing";
  const fromSpeech = async () => {
    if (subs.lines.length && !confirm("Replace the subtitles with new ones made from the video's speech? Your subtitle edits will be lost (Undo brings them back).")) return;
    setSpeechError(null);
    try {
      const lines = await window.vd.invoke("video:speechSubtitles", detail.project.id, spec);
      setSubs({ lines });
      if (!lines.length) setSpeechError("No speech was found in this video.");
    } catch (e) {
      const msg = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
      if (msg !== "cancelled") setSpeechError(msg);
    }
  };
  const setSubs = (patch: Partial<ProjectSpec["subtitles"]>, key?: string) => update((s) => ({ ...s, subtitles: { ...s.subtitles, ...patch } }), key);
  const setLine = (id: string, patch: Partial<ProjectSpec["subtitles"]["lines"][number]>, key?: string) =>
    update((s) => ({ ...s, subtitles: { ...s.subtitles, lines: s.subtitles.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) } }), key);
  const rebuild = async () => {
    if (subs.lines.length && !confirm("Replace the subtitles with fresh ones from the meeting transcript? Your subtitle edits will be lost (Undo brings them back).")) return;
    const lines = await window.vd.invoke("video:subtitles", detail.project.id, spec);
    setSubs({ lines });
  };
  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-md border border-line p-3 text-xs">
        <label className="flex items-center justify-between">
          <span>Show subtitles in the video</span>
          <Switch checked={subs.burnIn} onChange={(v) => setSubs({ burnIn: v })} label="Show subtitles in the video" />
        </label>
        <label className="flex items-center justify-between">
          <span>Save an .srt file with copies</span>
          <Switch checked={subs.exportSrt} onChange={(v) => setSubs({ exportSrt: v })} label="Save an .srt file with copies" />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        {detail.source === "meeting" ? (
          <Button className="h-7 px-2" onClick={() => void rebuild()}>
            {subs.lines.length ? "Rebuild from transcript" : "Make from transcript"}
          </Button>
        ) : transcribing ? (
          <span className="flex items-center gap-2 text-xs text-fg-muted">
            Listening… {Math.round((live?.fraction ?? 0) * 100)}%
            <Button className="h-7 px-2" variant="ghost" onClick={() => void window.vd.invoke("video:cancel", detail.project.id)}>
              Stop
            </Button>
          </span>
        ) : (
          <Button className="h-7 px-2" disabled={!detail.meeting.hasAudio} title={detail.meeting.hasAudio ? undefined : "This video has no sound"} onClick={() => void fromSpeech()}>
            Make subtitles from speech
          </Button>
        )}
        <Button
          className="h-7 px-2"
          variant="ghost"
          onClick={() => {
            const id = newId("t");
            setSubs({ lines: [...subs.lines, { id, start: t, end: Math.min(total, t + 3), text: "" }].sort((a, b) => a.start - b.start) });
            select({ kind: "sub", id });
          }}
        >
          + Line at playhead
        </Button>
      </div>
      {speechError && <p className="text-xs text-red-600 dark:text-red-400">{speechError}</p>}
      {subs.lines.length === 0 && (
        <p className="text-xs text-fg-muted">
          {detail.source === "meeting"
            ? "No subtitles. They're made from the meeting transcript for the parts you keep."
            : "No subtitles yet. Make them from what's said in the video (on this computer, with the offline speech model), or add lines yourself."}
        </p>
      )}
      <ul className="space-y-1.5">
        {subs.lines.map((l) => {
          const active = t >= l.start && t < l.end;
          return (
            <li
              key={l.id}
              className={cx("rounded-md border p-2", selection?.id === l.id ? "border-accent" : active ? "border-line bg-muted" : "border-transparent")}
              onFocus={() => select({ kind: "sub", id: l.id })}
            >
              <div className="mb-1 flex items-center gap-1.5 text-xs">
                <button className="tabular-nums text-accent hover:underline" onClick={() => seek(l.start + 0.01)}>
                  {clock(l.start * 1000)}–{clock(l.end * 1000)}
                </button>
                <input
                  aria-label="Speaker"
                  placeholder="Speaker"
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-xs text-fg-muted hover:border-line focus:border-accent focus:outline-none"
                  value={l.speaker ?? ""}
                  onChange={(e) => setLine(l.id, { speaker: e.target.value || undefined }, `sub-speaker-${l.id}`)}
                />
                <button
                  aria-label="Delete line"
                  className="rounded px-1 text-fg-muted hover:bg-muted hover:text-red-500"
                  onClick={() => setSubs({ lines: subs.lines.filter((x) => x.id !== l.id) })}
                >
                  ✕
                </button>
              </div>
              <textarea
                aria-label="Subtitle text"
                rows={Math.min(4, Math.ceil(l.text.length / 40) || 1)}
                className="w-full resize-none rounded border border-transparent bg-transparent px-1 text-sm hover:border-line focus:border-accent focus:outline-none"
                value={l.text}
                onChange={(e) => setLine(l.id, { text: e.target.value }, `sub-text-${l.id}`)}
              />
              {selection?.id === l.id && <Times item={l} total={total} t={t} onChange={(r) => setLine(l.id, r)} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- transcript

export function TranscriptPanel({ spec, detail, t, seek, cut }: Ctx & { cut: (from: number, to: number) => void }) {
  const placed = linesOnTimeline(spec, detail.clips.map(clipRef), detail.lines);
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-muted">
        What was said during the parts you keep. Click a line to jump to it; <b>Cut</b> removes that stretch from the video (Ctrl+Z to undo).
      </p>
      {placed.length === 0 && <p className="text-xs text-fg-muted">No transcript lines fall inside these recordings.</p>}
      <ul className="space-y-1">
        {placed.map(({ line, start, end }, i) => {
          const active = t >= start && t < end;
          const name = detail.speakers[line.speakerKey] ?? line.speakerKey;
          return (
            <li key={`${line.id}-${i}`} className={cx("group flex gap-2 rounded-md p-1.5 text-sm", active && "bg-muted")}>
              <button className="min-w-0 flex-1 text-left" onClick={() => seek(start + 0.01)}>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="tabular-nums text-fg-muted">{clock(start * 1000)}</span>
                  <span className="font-medium" style={{ color: speakerColor(line.speakerKey) }}>
                    {name}
                  </span>
                </div>
                <div className="leading-snug">{line.text}</div>
              </button>
              <Button
                variant="ghost"
                className="h-6 shrink-0 px-2 text-xs opacity-0 group-hover:opacity-100 focus:opacity-100"
                title="Remove this part of the video"
                onClick={() => cut(start, end)}
              >
                Cut
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
