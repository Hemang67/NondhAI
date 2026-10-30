import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VideoProjectDetail } from "@shared/ipc";
import {
  cutRange,
  deleteSegment,
  duration,
  locate,
  moveSegment,
  newId,
  segmentStarts,
  splitAt,
  type NRect,
  type ProjectSpec,
} from "@shared/video/project";
import { dropCovered } from "@shared/video/sensitive";
import { Button, cx, Input } from "../../components/ui";
import { clock, mediaUrl, useNav } from "../../nav";
import { ExportStatus, useVideoProgress } from "./LibraryPage";
import { assetUrl, Preview, type DrawMode, type Selection } from "./Preview";
import { Timeline } from "./Timeline";
import { BlurPanel, CropPanel, MediaPanel, SubtitlesPanel, TextPanel, TranscriptPanel, ZoomPanel, type PanelTab } from "./Panels";

const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: "blur", label: "Blur" },
  { id: "zoom", label: "Zoom" },
  { id: "crop", label: "Crop" },
  { id: "text", label: "Text" },
  { id: "media", label: "Media" },
  { id: "subtitles", label: "Subtitles" },
  { id: "transcript", label: "Transcript" },
];

const stripError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/**
 * Plays the edit as the export will look: the clip under the playhead in the <video>, the matching
 * stretch of meeting audio, and any added audio tracks, kept in step by a frame loop.
 */
function usePlayer(spec: ProjectSpec, detail: VideoProjectDetail | null) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const tracks = useRef<Record<string, HTMLAudioElement>>({});
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [trackLengths, setTrackLengths] = useState<Record<string, number>>({});
  const specRef = useRef(spec);
  specRef.current = spec;
  const tRef = useRef(0);
  const segIndex = useRef(0);
  const playingRef = useRef(false);
  const meetingId = detail?.meeting.id;
  const clipStart = useMemo(() => Object.fromEntries((detail?.clips ?? []).map((c) => [c.id, c.startMs / 1000])), [detail]);

  // Imported videos play their own soundtrack from the <video>; meeting edits use the recording.
  const ownSound = detail?.source === "library";
  // Meeting audio element.
  useEffect(() => {
    if (!meetingId || !detail?.meeting.hasAudio || ownSound) return;
    const a = new Audio(mediaUrl(meetingId));
    a.preload = "auto";
    audio.current = a;
    return () => {
      a.pause();
      a.src = "";
      audio.current = null;
    };
  }, [meetingId, detail?.meeting.hasAudio, ownSound]);

  // One element per added audio track.
  const trackKey = spec.audioTracks.map((a) => `${a.id}:${a.file}`).join("|");
  useEffect(() => {
    if (!meetingId) return;
    const els: Record<string, HTMLAudioElement> = {};
    for (const tr of specRef.current.audioTracks) {
      const el = new Audio(assetUrl(meetingId, tr.file));
      el.preload = "auto";
      el.onloadedmetadata = () => setTrackLengths((cur) => ({ ...cur, [tr.id]: el.duration }));
      els[tr.id] = el;
    }
    tracks.current = els;
    return () => Object.values(els).forEach((el) => (el.pause(), (el.src = "")));
  }, [meetingId, trackKey]);

  const syncAudio = useCallback(
    (time: number, hard: boolean) => {
      const s = specRef.current;
      const v = video.current;
      const loc = locate(s, time);
      const a = audio.current;
      if (v && ownSound) {
        v.muted = !s.meetingAudio.enabled;
        v.volume = Math.min(1, s.meetingAudio.volume);
      }
      if (a && loc) {
        a.muted = !s.meetingAudio.enabled;
        a.volume = Math.min(1, s.meetingAudio.volume);
        const want = (clipStart[loc.segment.clipId] ?? 0) + (v && !hard ? v.currentTime : loc.sourceTime);
        if (hard || Math.abs(a.currentTime - want) > 0.25) a.currentTime = want;
        if (playingRef.current && a.paused) void a.play().catch(() => {});
        if (!playingRef.current && !a.paused) a.pause();
      }
      for (const tr of s.audioTracks) {
        const el = tracks.current[tr.id];
        if (!el) continue;
        el.volume = Math.min(1, tr.volume);
        const rel = time - tr.start;
        const on = playingRef.current && rel >= 0 && rel < (el.duration || Infinity);
        if (on) {
          if (hard || Math.abs(el.currentTime - rel) > 0.3) el.currentTime = rel;
          if (el.paused) void el.play().catch(() => {});
        } else if (!el.paused) el.pause();
      }
    },
    [clipStart, ownSound],
  );

  /** Show the frame at timeline time `time` (loading another clip if needed). */
  const load = useCallback(
    (time: number) => {
      const s = specRef.current;
      const v = video.current;
      if (!v || !meetingId || !s.segments.length) return;
      const total = duration(s);
      const clamped = Math.max(0, Math.min(time, Math.max(0, total - 0.001)));
      const loc = locate(s, clamped);
      if (!loc) return;
      segIndex.current = loc.index;
      if (v.dataset.clip !== loc.segment.clipId) {
        v.dataset.clip = loc.segment.clipId;
        v.src = mediaUrl(meetingId, loc.segment.clipId);
      }
      v.currentTime = loc.sourceTime;
      tRef.current = clamped;
      setT(clamped);
      syncAudio(clamped, true);
    },
    [meetingId, syncAudio],
  );

  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    video.current?.pause();
    syncAudio(tRef.current, false);
  }, [syncAudio]);
  useEffect(() => window.vd.on("panel:hidden", pause), [pause]);

  const play = useCallback(() => {
    const s = specRef.current;
    if (tRef.current >= duration(s) - 0.05) load(0);
    playingRef.current = true;
    setPlaying(true);
    void video.current?.play().catch(() => {});
    syncAudio(tRef.current, true);
  }, [load, syncAudio]);

  // Frame loop: follow the video, hop to the next kept part at each segment's end.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const s = specRef.current;
      const v = video.current;
      const seg = s.segments[segIndex.current];
      if (v && seg) {
        const starts = segmentStarts(s);
        const time = starts[segIndex.current]! + Math.max(0, v.currentTime - seg.in);
        if (v.currentTime >= seg.out - 0.02 || v.ended) {
          const next = segIndex.current + 1;
          if (next >= s.segments.length) {
            pause();
            tRef.current = duration(s);
            setT(duration(s));
            return;
          }
          load(starts[next]!);
          void v.play().catch(() => {});
        } else {
          tRef.current = time;
          setT(time);
          syncAudio(time, false);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, load, pause, syncAudio]);

  // After an edit to the parts, redraw the frame under the playhead.
  const segKey = spec.segments.map((s) => `${s.clipId}:${s.in}:${s.out}`).join("|");
  useEffect(() => {
    if (!playingRef.current) load(tRef.current);
  }, [segKey, load]);

  const seek = useCallback(
    (time: number) => {
      load(time);
      if (playingRef.current) void video.current?.play().catch(() => {});
    },
    [load],
  );

  return { video, t, playing, play, pause, seek, trackLengths };
}

export function VideoEditor({ id }: { id: string }) {
  const nav = useNav();
  const [detail, setDetail] = useState<VideoProjectDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [spec, setSpecState] = useState<ProjectSpec | null>(null);
  const [title, setTitle] = useState("");
  const history = useRef<{ past: ProjectSpec[]; future: ProjectSpec[]; lastKey: string | null; lastAt: number }>({ past: [], future: [], lastKey: null, lastAt: 0 });
  const [, bump] = useState(0);
  const [tab, setTab] = useState<PanelTab>("blur");
  const [selection, setSelection] = useState<Selection>(null);
  const [draw, setDraw] = useState<DrawMode>(null);
  const [marks, setMarks] = useState<{ in: number | null; out: number | null }>({ in: null, out: null });
  const [saved, setSaved] = useState<"saved" | "saving" | "dirty">("saved");
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanned, setScanned] = useState<number | null>(null);
  const [showExport, setShowExport] = useState(false);
  const progress = useVideoProgress();
  const live = progress[id];

  const reload = useCallback(
    (withSpec: boolean) =>
      void window.vd.invoke("video:get", id).then((d) => {
        if (!d) return setMissing(true);
        setDetail(d);
        if (withSpec) {
          setSpecState(d.project.spec);
          setTitle(d.project.title);
        }
      }),
    [id],
  );
  useEffect(() => {
    reload(true);
    return window.vd.on("video:changed", () => reload(false));
  }, [reload]);

  const empty: ProjectSpec = useMemo(
    () => ({ version: 1, segments: [], crop: null, blurs: [], zooms: [], texts: [], images: [], meetingAudio: { enabled: true, volume: 1 }, audioTracks: [], subtitles: { lines: [], burnIn: true, exportSrt: true } }),
    [],
  );
  const player = usePlayer(spec ?? empty, detail);
  const { t, seek } = player;

  /** Apply an edit. Edits with the same key in quick succession (a drag, typing) undo as one. */
  const update = useCallback((fn: (s: ProjectSpec) => ProjectSpec, key?: string) => {
    setSpecState((cur) => {
      if (!cur) return cur;
      const next = fn(cur);
      if (next === cur) return cur;
      const h = history.current;
      const now = Date.now();
      if (!(key && h.lastKey === key && now - h.lastAt < 1500)) {
        h.past.push(cur);
        if (h.past.length > 100) h.past.shift();
      }
      h.future = [];
      h.lastKey = key ?? null;
      h.lastAt = now;
      return next;
    });
    setSaved("dirty");
    bump((n) => n + 1);
  }, []);
  const undo = useCallback(() => {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev) return;
    setSpecState((cur) => {
      if (cur) h.future.push(cur);
      return prev;
    });
    h.lastKey = null;
    setSaved("dirty");
    bump((n) => n + 1);
  }, []);
  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future.pop();
    if (!next) return;
    setSpecState((cur) => {
      if (cur) h.past.push(cur);
      return next;
    });
    h.lastKey = null;
    setSaved("dirty");
    bump((n) => n + 1);
  }, []);

  // Autosave shortly after changes stop.
  const pendingSave = useRef<ProjectSpec | null>(null);
  const save = useCallback(async () => {
    const s = pendingSave.current;
    if (!s) return;
    pendingSave.current = null;
    setSaved("saving");
    await window.vd.invoke("video:save", id, { spec: s });
    setSaved(pendingSave.current ? "dirty" : "saved");
  }, [id]);
  useEffect(() => {
    if (!spec || saved !== "dirty") return;
    pendingSave.current = spec;
    const timer = setTimeout(() => void save(), 600);
    return () => clearTimeout(timer);
  }, [spec, saved, save]);
  useEffect(() => () => void save(), [save]);

  const total = spec ? duration(spec) : 0;
  // Meeting recordings are numbered in recording order; imported videos in the order they appear in the edit.
  const segOrder = (spec?.segments ?? []).map((s) => s.clipId).filter((id, i, all) => all.indexOf(id) === i).join(",");
  const clipIndex = useMemo(
    () =>
      detail?.source === "library"
        ? Object.fromEntries(segOrder.split(",").map((id, i) => [id, i]))
        : Object.fromEntries((detail?.clips ?? []).map((c, i) => [c.id, i])),
    [detail, segOrder],
  );
  const base = useMemo(() => {
    const c = detail?.clips.find((x) => x.id === spec?.segments[0]?.clipId);
    return { width: c?.width ?? 1280, height: c?.height ?? 720 };
  }, [detail, spec?.segments]);

  const cut = useCallback(
    (from: number, to: number) => {
      if (!spec) return;
      if (Math.abs(to - from) >= total - 0.05) return setError("That would remove the whole video.");
      update((s) => cutRange(s, from, to));
      setMarks({ in: null, out: null });
      seek(Math.min(from, to));
    },
    [spec, total, update, seek],
  );

  const segIndex = spec && selection?.kind === "segment" ? spec.segments.findIndex((s) => s.id === selection.id) : -1;
  const deleteSelected = useCallback(() => {
    if (!spec || !selection) return;
    if (selection.kind === "segment") {
      if (spec.segments.length === 1) return setError("A video needs at least one part. Cut a range instead.");
      update((s) => deleteSegment(s, s.segments.findIndex((x) => x.id === selection.id)));
    } else if (selection.kind === "blur") update((s) => ({ ...s, blurs: s.blurs.filter((x) => x.id !== selection.id) }));
    else if (selection.kind === "zoom") update((s) => ({ ...s, zooms: (s.zooms ?? []).filter((x) => x.id !== selection.id) }));
    else if (selection.kind === "text") update((s) => ({ ...s, texts: s.texts.filter((x) => x.id !== selection.id) }));
    else if (selection.kind === "image") update((s) => ({ ...s, images: s.images.filter((x) => x.id !== selection.id) }));
    else if (selection.kind === "sub") update((s) => ({ ...s, subtitles: { ...s.subtitles, lines: s.subtitles.lines.filter((x) => x.id !== selection.id) } }));
    else if (selection.kind === "track") update((s) => ({ ...s, audioTracks: s.audioTracks.filter((x) => x.id !== selection.id) }));
    setSelection(null);
  }, [spec, selection, update]);

  const onDrawn = (r: NRect | null) => {
    const mode = draw;
    setDraw(null);
    if (!r) return;
    if (mode === "crop") update((s) => ({ ...s, crop: r }));
    if (mode === "blur") {
      const bid = newId("b");
      update((s) => ({ ...s, blurs: [...s.blurs, { id: bid, rect: r, start: t, end: total, strength: 20 }] }));
      setSelection({ kind: "blur", id: bid });
    }
    if (mode === "zoom") {
      const zid = newId("z");
      // Five seconds from the playhead, or the last five seconds near the end.
      const start = Math.max(0, Math.min(t, total - 5));
      update((s) => ({ ...s, zooms: [...(s.zooms ?? []), { id: zid, rect: r, start, end: Math.min(total, start + 5), size: 0.9, blur: 20 }] }));
      setSelection({ kind: "zoom", id: zid });
    }
  };

  // Keyboard shortcuts (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (e.ctrlKey && (k === "y" || (k === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (k === " ") {
        e.preventDefault();
        if (player.playing) player.pause();
        else player.play();
      } else if (k === "s" && !e.ctrlKey) update((s) => splitAt(s, t));
      else if (k === "i") setMarks((m) => ({ in: t, out: m.out !== null && m.out > t ? m.out : null }));
      else if (k === "o") setMarks((m) => ({ in: m.in !== null && m.in < t ? m.in : 0, out: t }));
      else if (k === "delete" || k === "backspace") deleteSelected();
      else if (k === "escape") {
        setDraw(null);
        setSelection(null);
      } else if (k === "arrowleft" || k === "arrowright") {
        e.preventDefault();
        seek(t + (k === "arrowleft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / 15));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, player, update, t, deleteSelected, seek]);

  const scan = async () => {
    if (!spec) return;
    setScanError(null);
    setScanned(null);
    player.pause();
    try {
      await save();
      const boxes = await window.vd.invoke("video:findSensitive", id, spec);
      // Fresh suggestions replace earlier unreviewed ones; spots already blurred aren't suggested again.
      const fresh = dropCovered(boxes, spec.blurs);
      update((s) => ({ ...s, blurs: [...s.blurs.filter((b) => !b.suggested), ...fresh] }));
      setScanned(fresh.length);
      setTab("blur");
    } catch (e) {
      const msg = stripError(e);
      if (msg !== "cancelled") setScanError(msg);
    }
  };

  const startExport = async () => {
    if (!spec) return;
    setError(null);
    const pending = spec.blurs.filter((b) => b.suggested).length;
    if (pending && !confirm(`${pending} suggested blur${pending === 1 ? " is" : "s are"} not reviewed yet and won't be in the export. Export anyway?`)) return;
    player.pause();
    pendingSave.current = spec;
    await save();
    try {
      await window.vd.invoke("video:export", id);
      setShowExport(true);
    } catch (e) {
      setError(stripError(e));
    }
  };

  if (missing)
    return (
      <div className="p-6 text-sm">
        This edit no longer exists.{" "}
        <button className="text-accent underline" onClick={() => nav({ tab: "library" })}>
          Back to the library
        </button>
      </div>
    );
  if (!detail || !spec) return null;

  const project = detail.project;
  const exporting = live ? live.phase === "rendering" || live.phase === "preparing" : project.exportStatus === "rendering";
  const missingClip = spec.segments.some((s) => !detail.clips.find((c) => c.id === s.clipId));
  const panelCtx = { spec, detail, t, total, base, update, selection, select: setSelection, seek, draw, setDraw };
  const h = history.current;

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <Button variant="ghost" className="h-7 px-2" onClick={() => nav({ tab: "library" })}>
          ← Library
        </Button>
        <Input
          aria-label="Video name"
          className="h-7 max-w-xs font-medium"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== project.title && void window.vd.invoke("video:save", id, { title })}
        />
        <span className="text-xs text-fg-muted">{saved === "saved" ? "Saved" : "Saving…"}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" className="h-7 px-2" disabled={!h.past.length} onClick={undo} title="Undo (Ctrl+Z)">
            Undo
          </Button>
          <Button variant="ghost" className="h-7 px-2" disabled={!h.future.length} onClick={redo} title="Redo (Ctrl+Y)">
            Redo
          </Button>
          <ExportStatus p={project} live={live} />
          {exporting ? (
            <>
              <div className="h-1.5 w-28 overflow-hidden rounded bg-muted">
                <div className="h-full bg-accent transition-all" style={{ width: `${Math.round((live?.fraction ?? 0) * 100)}%` }} />
              </div>
              <Button className="h-7 px-2" variant="ghost" onClick={() => void window.vd.invoke("video:cancel", id)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button className="h-7 px-3" variant="primary" disabled={missingClip || live?.phase === "scanning"} onClick={() => void startExport()}>
              {project.exportStatus === "done" ? "Export again" : "Export video"}
            </Button>
          )}
          {project.exportStatus === "done" && !exporting && (
            <>
              <Button className="h-7 px-2" onClick={() => setShowExport((v) => !v)}>
                {showExport ? "Back to editing" : "Watch export"}
              </Button>
              <Button className="h-7 px-2" onClick={() => void window.vd.invoke("video:saveCopy", id)}>
                Save a copy…
              </Button>
            </>
          )}
        </div>
      </header>
      {(error || (live?.phase === "error" && live.error) || missingClip) && (
        <div className="flex items-center gap-2 border-b border-line bg-red-500/10 px-3 py-1.5 text-xs text-red-600 dark:text-red-400">
          <span className="flex-1">
            {missingClip ? "A screen recording used in this edit was deleted. Remove its parts from the timeline to export." : error ?? `Export failed: ${live?.error}`}
          </span>
          {error && (
            <button aria-label="Dismiss" onClick={() => setError(null)}>
              ✕
            </button>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Preview and transport */}
        <div className="flex min-w-0 flex-1 flex-col bg-bg">
          <div className="relative min-h-0 flex-1 p-3">
            {showExport && project.exportStatus === "done" ? (
              <video
                key={project.exportedAt ?? 0}
                src={`${mediaUrl(detail.meeting.id, "edit", id)}?v=${project.exportedAt}`}
                controls
                autoPlay
                className="size-full bg-black object-contain"
              />
            ) : (
              <Preview
                spec={spec}
                base={base}
                meetingId={detail.meeting.id}
                t={t}
                video={player.video}
                selection={selection}
                onSelect={setSelection}
                draw={draw}
                onDrawn={onDrawn}
                update={update}
              />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line bg-panel px-3 py-1.5">
            <Button variant="primary" className="h-7 w-16 px-2" onClick={() => (player.playing ? player.pause() : player.play())} title="Play / pause (Space)">
              {player.playing ? "Pause" : "Play"}
            </Button>
            <span className="w-24 text-xs tabular-nums text-fg-muted">
              {clock(t * 1000)} / {clock(total * 1000)}
            </span>
            <span className="mx-1 h-5 w-px bg-line" />
            <Button className="h-7 px-2" onClick={() => update((s) => splitAt(s, t))} title="Split the part under the playhead (S)">
              Split
            </Button>
            <Button className="h-7 px-2" disabled={segIndex < 0 || spec.segments.length < 2} onClick={deleteSelected} title="Remove the selected part">
              Delete part
            </Button>
            <Button className="h-7 px-2" disabled={segIndex <= 0} onClick={() => update((s) => moveSegment(s, segIndex, -1))} title="Move the selected part earlier">
              ◀ Move
            </Button>
            <Button className="h-7 px-2" disabled={segIndex < 0 || segIndex >= spec.segments.length - 1} onClick={() => update((s) => moveSegment(s, segIndex, 1))} title="Move the selected part later">
              Move ▶
            </Button>
            <span className="mx-1 h-5 w-px bg-line" />
            <Button className="h-7 px-2" onClick={() => setMarks((m) => ({ in: t, out: m.out !== null && m.out > t ? m.out : null }))} title="Mark the start of a stretch to cut (I)">
              Mark in
            </Button>
            <Button className="h-7 px-2" onClick={() => setMarks((m) => ({ in: m.in !== null && m.in < t ? m.in : 0, out: t }))} title="Mark the end of a stretch to cut (O)">
              Mark out
            </Button>
            <Button
              className={cx("h-7 px-2", marks.in !== null && marks.out !== null && "border-red-500 text-red-600 dark:text-red-400")}
              disabled={marks.in === null || marks.out === null}
              onClick={() => cut(marks.in!, marks.out!)}
              title="Remove the marked stretch"
            >
              Cut {marks.in !== null && marks.out !== null ? `${clock(marks.in * 1000)}–${clock(marks.out * 1000)}` : "marked"}
            </Button>
            {(marks.in !== null || marks.out !== null) && (
              <Button variant="ghost" className="h-7 px-2" onClick={() => setMarks({ in: null, out: null })}>
                Clear marks
              </Button>
            )}
          </div>
        </div>

        {/* Tools */}
        <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-panel">
          <div className="flex flex-wrap gap-0.5 border-b border-line p-1.5" role="tablist">
            {TABS.filter((x) => x.id !== "transcript" || detail.source === "meeting").map((x) => (
              <button
                key={x.id}
                role="tab"
                aria-selected={tab === x.id}
                onClick={() => setTab(x.id)}
                className={cx("rounded px-2 py-1 text-xs", tab === x.id ? "bg-muted font-medium" : "text-fg-muted hover:bg-muted")}
              >
                {x.label}
                {x.id === "blur" && spec.blurs.some((b) => b.suggested) && <span className="ml-1 inline-block size-1.5 rounded-full bg-amber-500 align-middle" />}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {tab === "crop" && <CropPanel {...panelCtx} />}
            {tab === "blur" && (
              <BlurPanel
                {...panelCtx}
                scan={live}
                onScan={() => void scan()}
                onCancelScan={() => void window.vd.invoke("video:cancel", id)}
                scanError={scanError}
                scanned={scanned}
              />
            )}
            {tab === "zoom" && <ZoomPanel {...panelCtx} />}
            {tab === "text" && <TextPanel {...panelCtx} />}
            {tab === "media" && <MediaPanel {...panelCtx} trackLengths={player.trackLengths} />}
            {tab === "subtitles" && <SubtitlesPanel {...panelCtx} live={live} />}
            {tab === "transcript" && <TranscriptPanel {...panelCtx} cut={cut} />}
          </div>
        </aside>
      </div>

      <div className="h-60 shrink-0">
        <Timeline
          spec={spec}
          total={total}
          t={t}
          onSeek={seek}
          selection={selection}
          onSelect={(s) => {
            setSelection(s);
            if (s && s.kind !== "segment" && s.kind !== "track") setTab(s.kind === "sub" ? "subtitles" : s.kind === "image" ? "media" : s.kind);
            if (s?.kind === "track") setTab("media");
          }}
          update={update}
          clipIndex={clipIndex}
          marks={marks}
          trackLengths={player.trackLengths}
        />
      </div>
    </div>
  );
}
