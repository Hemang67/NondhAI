import { useCallback, useEffect, useState } from "react";
import type { ClipRecord } from "@shared/types";
import type { LibraryMeeting, VideoProgress } from "@shared/ipc";
import { duration, LIBRARY, type LibraryVideo, type VideoProject } from "@shared/video/project";
import { Badge, Button, cx, Input } from "../../components/ui";
import { clock, CLIP_KIND, mediaUrl, useNav } from "../../nav";
import { ImportedVideos } from "./ImportedVideos";

const clipLen = (c: ClipRecord) => ((c.endMs ?? c.startMs) - c.startMs) / 1000;
const dateTime = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Live export/scan progress per edit, shared by the library and the editor. */
export function useVideoProgress(): Record<string, VideoProgress> {
  const [progress, setProgress] = useState<Record<string, VideoProgress>>({});
  useEffect(
    () =>
      window.vd.on("video:progress", (id, p) =>
        setProgress((cur) => ({ ...cur, [id]: p })),
      ),
    [],
  );
  return progress;
}

export function ExportStatus({ p, live }: { p: VideoProject; live?: VideoProgress }) {
  if (live && (live.phase === "rendering" || live.phase === "preparing"))
    return <Badge tone="accent">Exporting {Math.round(live.fraction * 100)}%</Badge>;
  if (p.exportStatus === "rendering") return <Badge tone="accent">Exporting…</Badge>;
  if (p.exportStatus === "done") return <Badge tone="accent">Exported</Badge>;
  if (p.exportStatus === "error") return <Badge tone="cloud">Export failed</Badge>;
  return <Badge>Not exported</Badge>;
}

export function LibraryPage() {
  const [data, setData] = useState<{ meetings: LibraryMeeting[]; imported: LibraryVideo[]; projects: VideoProject[] } | null>(null);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [merge, setMerge] = useState<MergeRequest | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = useVideoProgress();
  const nav = useNav();

  const load = useCallback(() => void window.vd.invoke("video:library").then(setData), []);
  useEffect(() => {
    load();
    const offs = [window.vd.on("video:changed", load), window.vd.on("meetings:changed", load)];
    return () => offs.forEach((o) => o());
  }, [load]);

  const create = async (meetingId: string | null, clipIds: string[], title?: string) => {
    setError(null);
    try {
      const p = await window.vd.invoke("video:create", meetingId, clipIds, title);
      nav({ tab: "library", projectId: p.id });
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };

  const toggle = (meetingId: string, clipId: string) =>
    setSelected((cur) => {
      const list = cur[meetingId] ?? [];
      return { ...cur, [meetingId]: list.includes(clipId) ? list.filter((x) => x !== clipId) : [...list, clipId] };
    });

  const importFiles = async (paths?: string[]) => {
    setError(null);
    const added = await window.vd.invoke("video:import", paths);
    if (paths?.length && !added.length) setError("Those files aren't videos this app can import.");
  };

  if (!data) return null;
  const titleOf = (id: string | null) => (id ? (data.meetings.find((m) => m.id === id)?.title ?? "Meeting") : "Imported video");

  return (
    <div
      className="relative h-full overflow-y-auto"
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const paths = [...e.dataTransfer.files].map((f) => window.vd.pathForFile(f)).filter(Boolean);
        if (paths.length) void importFiles(paths);
      }}
    >
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-accent/10 ring-4 ring-inset ring-accent">
          <span className="rounded-lg bg-panel px-4 py-2 text-sm font-medium shadow">Drop videos to import them</span>
        </div>
      )}
      <div className="mx-auto max-w-4xl p-6">
        <h1 className="text-xl font-semibold">Video library</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Edit the screen recordings from your meetings, or videos you import: cut, crop, blur, add text, images, music and subtitles, and merge several into
          one video. Your originals are never changed.
        </p>
        {error && <p className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">Your edits</h2>
          {data.projects.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line p-4 text-sm text-fg-muted">No edits yet. Import a video or pick a screen recording below to start one.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
              {data.projects.map((p) => (
                <li key={p.id} className="p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button className="min-w-0 flex-1 text-left" onClick={() => nav({ tab: "library", projectId: p.id })}>
                      <div className="truncate text-sm font-medium">{p.title}</div>
                      <div className="text-xs text-fg-muted">
                        {titleOf(p.meetingId)} · {clock(duration(p.spec) * 1000)} · {p.spec.segments.length} part{p.spec.segments.length === 1 ? "" : "s"}
                      </div>
                    </button>
                    <ExportStatus p={p} live={progress[p.id]} />
                    {p.exportStatus === "done" && (
                      <>
                        <Button className="h-7 px-2" variant={preview === p.id ? "primary" : "secondary"} onClick={() => setPreview(preview === p.id ? null : p.id)}>
                          {preview === p.id ? "Close" : "Play"}
                        </Button>
                        <Button className="h-7 px-2" onClick={() => void window.vd.invoke("video:saveCopy", p.id)}>
                          Save a copy…
                        </Button>
                      </>
                    )}
                    <Button className="h-7 px-2" variant="primary" onClick={() => nav({ tab: "library", projectId: p.id })}>
                      Edit
                    </Button>
                    <Button
                      className="h-7 px-2"
                      variant="ghost"
                      onClick={() => confirm(`Delete the edit "${p.title}"? The original videos are kept.`) && void window.vd.invoke("video:delete", p.id)}
                    >
                      Delete
                    </Button>
                  </div>
                  {p.exportStatus === "error" && p.exportError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{p.exportError}</p>}
                  {preview === p.id && p.exportFile && (
                    <video
                      key={`${p.exportFile}${p.exportedAt}`}
                      src={`${mediaUrl(p.meetingId ?? LIBRARY, "edit", p.id)}?v=${p.exportedAt}`}
                      controls
                      autoPlay
                      className="mt-3 max-h-[60vh] w-full rounded-md bg-black"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <ImportedVideos
          videos={data.imported}
          projects={data.projects}
          progress={progress}
          onImport={() => void importFiles()}
          onEdit={(ids) => void create(null, ids)}
          onMerge={(ids) =>
            setMerge({
              meetingId: null,
              defaultTitle: `${ids.length} videos merged`,
              ordered: true,
              items: ids
                .map((id) => data.imported.find((v) => v.id === id)!)
                .map((v) => ({ id: v.id, label: v.title, seconds: (v.durationMs ?? 0) / 1000 })),
            })
          }
        />

        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold">Screen recordings</h2>
          {data.meetings.length === 0 && (
            <p className="rounded-lg border border-dashed border-line p-4 text-sm text-fg-muted">
              No screen recordings yet. During a meeting, press <b>Record screen</b> in the recording window to capture your screen, a window or a region.
            </p>
          )}
          <div className="space-y-4">
            {data.meetings.map((m) => {
              const sel = selected[m.id] ?? [];
              return (
                <div key={m.id} className="rounded-lg border border-line bg-panel">
                  <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{m.title}</div>
                      <div className="text-xs text-fg-muted">
                        {dateTime(m.startedAt)} · {m.clips.length} recording{m.clips.length === 1 ? "" : "s"}
                      </div>
                    </div>
                    {m.clips.length > 1 && (
                      <>
                        <Button
                          className="h-7 px-2"
                          variant="ghost"
                          onClick={() => setSelected((cur) => ({ ...cur, [m.id]: sel.length === m.clips.length ? [] : m.clips.map((c) => c.id) }))}
                        >
                          {sel.length === m.clips.length ? "Clear selection" : "Select all"}
                        </Button>
                        <Button
                          className="h-7 px-2"
                          variant="primary"
                          disabled={sel.length < 2}
                          title={sel.length < 2 ? "Tick two or more recordings to merge them" : undefined}
                          onClick={() =>
                            setMerge({
                              meetingId: m.id,
                              defaultTitle: `${m.title} — ${sel.length} clips merged`,
                              ordered: false,
                              items: m.clips.filter((c) => sel.includes(c.id)).map((c) => ({ id: c.id, label: c.label, seconds: clipLen(c) })),
                            })
                          }
                        >
                          {sel.length >= 2 ? `Merge ${sel.length} selected…` : "Merge selected…"}
                        </Button>
                      </>
                    )}
                  </header>
                  <ul className="divide-y divide-line">
                    {m.clips.map((c, i) => (
                      <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                        {m.clips.length > 1 && (
                          <input type="checkbox" aria-label={`Select recording ${i + 1}`} checked={sel.includes(c.id)} onChange={() => toggle(m.id, c.id)} />
                        )}
                        <span className="w-6 text-xs text-fg-muted">#{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        <Badge>{CLIP_KIND[c.kind]}</Badge>
                        <span className="w-24 text-right text-xs tabular-nums text-fg-muted">
                          at {clock(c.startMs)} · {clock(clipLen(c) * 1000)}
                        </span>
                        <Button className="h-7 px-2" onClick={() => void create(m.id, [c.id])}>
                          Edit
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      </div>
      {merge && (
        <MergeDialog
          {...merge}
          onCancel={() => setMerge(null)}
          onMerge={(title) => void create(merge.meetingId, merge.items.map((c) => c.id), title).then(() => setMerge(null))}
        />
      )}
    </div>
  );
}

interface MergeRequest {
  meetingId: string | null;
  defaultTitle: string;
  /** Items are in the order they'll be joined: the order ticked (imported videos), or recording order. */
  ordered: boolean;
  items: Array<{ id: string; label: string; seconds: number }>;
}

/** Asks before merging: shows exactly what will be joined, in what order. */
function MergeDialog({ items, defaultTitle, ordered: asTicked, onCancel, onMerge }: MergeRequest & { onCancel: () => void; onMerge: (title: string) => void }) {
  const ordered = items;
  const [title, setTitle] = useState(defaultTitle);
  const total = ordered.reduce((t, c) => t + c.seconds, 0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div role="dialog" aria-modal="true" aria-labelledby="merge-title" className="w-full max-w-md rounded-lg border border-line bg-panel p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 id="merge-title" className="text-base font-semibold">
          Merge {items.length} videos?
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          They will be joined into one new video {asTicked ? "in the order you ticked them" : "in the order they were recorded"} ({clock(total * 1000)} in
          total). The originals stay as they are, and you can trim, reorder or remove parts in the editor.
        </p>
        <ol className="mt-3 space-y-1 rounded-md bg-muted p-2 text-sm">
          {ordered.map((c, i) => (
            <li key={c.id} className="flex gap-2">
              <span className="text-fg-muted">{i + 1}.</span>
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              <span className="tabular-nums text-fg-muted">{clock(c.seconds * 1000)}</span>
            </li>
          ))}
        </ol>
        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-xs text-fg-muted">Name of the new video</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" className={cx(!title.trim() && "opacity-50")} disabled={!title.trim()} onClick={() => onMerge(title.trim())}>
            Merge into a new video
          </Button>
        </div>
      </div>
    </div>
  );
}
