import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { segLen, segmentStarts, type ProjectSpec, type TimedRange } from "@shared/video/project";
import { cx } from "../../components/ui";
import { clock } from "../../nav";
import type { Selection } from "./Preview";

export const CLIP_COLORS = ["#0ea5e9", "#a855f7", "#22c55e", "#f59e0b", "#ef4444", "#14b8a6", "#ec4899", "#6366f1"];

type Row = { kind: "blur" | "text" | "image" | "sub"; label: string; items: Array<TimedRange & { id: string; label: string; muted?: boolean }>; color: string };

/**
 * The edit, left to right: the kept parts of each recording, and a row per kind of element.
 * Click to move the playhead; drag a bar to move it, or its ends to change when it shows.
 */
export function Timeline({
  spec,
  total,
  t,
  onSeek,
  selection,
  onSelect,
  update,
  clipIndex,
  marks,
  trackLengths,
}: {
  spec: ProjectSpec;
  total: number;
  t: number;
  onSeek: (t: number) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  update: (fn: (s: ProjectSpec) => ProjectSpec, key: string) => void;
  clipIndex: Record<string, number>;
  marks: { in: number | null; out: number | null };
  trackLengths: Record<string, number>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pps = (Math.max(100, width - 16) / Math.max(1, total)) * zoom; // pixels per second
  const content = Math.max(width - 16, total * pps);

  // Keep the playhead in view while playing when zoomed in.
  useEffect(() => {
    const el = scroller.current;
    if (!el || zoom === 1) return;
    const x = t * pps;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - 40);
  }, [t, pps, zoom]);

  const timeAt = (clientX: number) => {
    const r = scroller.current!.getBoundingClientRect();
    return Math.max(0, Math.min(total, (clientX - r.left + scroller.current!.scrollLeft - 8) / pps));
  };

  const scrub = (e: RPointerEvent) => {
    e.preventDefault();
    onSeek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => onSeek(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const starts = segmentStarts(spec);
  const rows: Row[] = [
    { kind: "blur", label: "Blur", color: "#64748b", items: spec.blurs.map((b) => ({ ...b, label: b.suggested ? `Suggested: ${b.suggested.reason}` : "Blur", muted: !!b.suggested })) },
    { kind: "text", label: "Text", color: "#d97706", items: spec.texts.map((x) => ({ ...x, label: x.text || "Text" })) },
    { kind: "image", label: "Images", color: "#059669", items: spec.images.map((x) => ({ ...x, label: "Image" })) },
    { kind: "sub", label: "Subtitles", color: "#7c3aed", items: spec.subtitles.lines.map((x) => ({ ...x, label: x.text })) },
  ];

  const setTimes = (kind: Row["kind"], id: string, start: number, end: number) =>
    update((s) => {
      const fix = <T extends TimedRange & { id: string }>(xs: T[]) => xs.map((x) => (x.id === id ? { ...x, start, end } : x));
      if (kind === "blur") return { ...s, blurs: fix(s.blurs) };
      if (kind === "text") return { ...s, texts: fix(s.texts) };
      if (kind === "image") return { ...s, images: fix(s.images) };
      return { ...s, subtitles: { ...s.subtitles, lines: fix(s.subtitles.lines) } };
    }, `bar-${id}`);

  const dragBar = (e: RPointerEvent, kind: Row["kind"], item: TimedRange & { id: string }, mode: "move" | "start" | "end") => {
    e.preventDefault();
    e.stopPropagation();
    onSelect({ kind, id: item.id });
    const x0 = e.clientX;
    const { start, end } = item;
    const len = end - start;
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) / pps;
      if (mode === "move") {
        const s = Math.max(0, Math.min(total - len, start + d));
        setTimes(kind, item.id, s, s + len);
      } else if (mode === "start") setTimes(kind, item.id, Math.max(0, Math.min(end - 0.1, start + d)), end);
      else setTimes(kind, item.id, start, Math.min(total, Math.max(start + 0.1, end + d)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const step = total > 600 ? 60 : total > 120 ? 10 : total > 30 ? 5 : 1;
  const ticks = Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
  const markL = marks.in ?? null;
  const markR = marks.out ?? null;

  return (
    <div className="flex min-h-0 border-t border-line bg-panel text-xs">
      <div className="w-20 shrink-0 border-r border-line pt-6 text-fg-muted">
        <div className="flex h-10 items-center px-2 font-medium text-fg">Video</div>
        {rows.map((r) => (
          <div key={r.kind} className="flex h-6 items-center px-2">
            {r.label}
          </div>
        ))}
        {spec.audioTracks.length > 0 && <div className="flex h-6 items-center px-2">Audio</div>}
        <div className="flex h-7 items-center gap-1 px-1">
          <button aria-label="Zoom out" className="rounded px-1.5 hover:bg-muted" onClick={() => setZoom((z) => Math.max(1, z / 2))}>
            −
          </button>
          <button aria-label="Zoom in" className="rounded px-1.5 hover:bg-muted" onClick={() => setZoom((z) => Math.min(32, z * 2))}>
            +
          </button>
        </div>
      </div>
      <div ref={scroller} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="relative px-2" style={{ width: content + 16 }}>
          {/* Ruler: click or drag to move the playhead. */}
          <div className="relative h-6 cursor-pointer border-b border-line" onPointerDown={scrub}>
            {ticks.map((s) => (
              <div key={s} className="absolute top-0 h-full border-l border-line pl-1 text-[10px] text-fg-muted" style={{ left: s * pps }}>
                {clock(s * 1000)}
              </div>
            ))}
            {markL !== null && (
              <div
                className="absolute top-0 h-full bg-red-500/25"
                style={{ left: markL * pps, width: Math.max(2, ((markR ?? markL) - markL) * pps) }}
                title="Marked for cutting"
              />
            )}
          </div>

          {/* Kept parts of the recordings. */}
          <div className="relative h-10">
            {spec.segments.map((s, i) => {
              const n = clipIndex[s.clipId] ?? 0;
              const isSel = selection?.kind === "segment" && selection.id === s.id;
              return (
                <button
                  key={s.id}
                  className={cx("absolute top-1 flex h-8 items-center overflow-hidden rounded px-1.5 text-left text-[11px] text-white", isSel && "ring-2 ring-fg")}
                  style={{ left: starts[i]! * pps, width: Math.max(4, segLen(s) * pps - 2), background: CLIP_COLORS[n % CLIP_COLORS.length] }}
                  onPointerDown={(e) => {
                    onSelect({ kind: "segment", id: s.id });
                    scrub(e);
                  }}
                  title={`Recording #${n + 1}: ${clock(s.in * 1000)}–${clock(s.out * 1000)} of the original`}
                >
                  <span className="truncate">
                    #{n + 1} · {clock(segLen(s) * 1000)}
                  </span>
                </button>
              );
            })}
          </div>

          {rows.map((r) => (
            <div key={r.kind} className="relative h-6 border-t border-line/60">
              {r.items.map((it) => {
                const isSel = selection?.kind === r.kind && selection.id === it.id;
                return (
                  <div
                    key={it.id}
                    className={cx("absolute top-0.5 flex h-5 cursor-grab items-center overflow-hidden rounded text-[10px] text-white", isSel && "ring-2 ring-fg", it.muted && "opacity-60")}
                    style={{
                      left: it.start * pps,
                      width: Math.max(6, (it.end - it.start) * pps),
                      background: it.muted ? undefined : r.color,
                      backgroundImage: it.muted ? `repeating-linear-gradient(45deg, ${r.color}, ${r.color} 4px, #f59e0b 4px, #f59e0b 8px)` : undefined,
                    }}
                    onPointerDown={(e) => dragBar(e, r.kind, it, "move")}
                    title={it.label}
                  >
                    <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize" onPointerDown={(e) => dragBar(e, r.kind, it, "start")} />
                    <span className="pointer-events-none truncate px-2">{it.label}</span>
                    <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize" onPointerDown={(e) => dragBar(e, r.kind, it, "end")} />
                  </div>
                );
              })}
            </div>
          ))}

          {spec.audioTracks.length > 0 && (
            <div className="relative h-6 border-t border-line/60">
              {spec.audioTracks.map((a) => (
                <button
                  key={a.id}
                  className={cx("absolute top-0.5 h-5 truncate rounded bg-rose-500 px-2 text-left text-[10px] text-white", selection?.id === a.id && "ring-2 ring-fg")}
                  style={{ left: a.start * pps, width: Math.max(6, Math.min(total - a.start, trackLengths[a.id] ?? 5) * pps) }}
                  onClick={() => onSelect({ kind: "track", id: a.id })}
                >
                  Audio
                </button>
              ))}
            </div>
          )}
          <div className="h-7" />

          {/* Playhead */}
          <div className="pointer-events-none absolute bottom-0 top-0 w-px bg-red-500" style={{ left: 8 + t * pps }}>
            <div className="absolute -left-1 top-0 size-2 rotate-45 bg-red-500" />
          </div>
        </div>
      </div>
    </div>
  );
}
