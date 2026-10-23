import { useEffect, useState } from "react";
import type { VideoProgress } from "@shared/ipc";
import type { LibraryVideo, VideoProject } from "@shared/video/project";
import { Badge, Button, Input } from "../../components/ui";
import { clock, CLIP_KIND } from "../../nav";

/** Videos brought in from outside the app: import (button or drag and drop), edit, merge, rename, remove. */
export function ImportedVideos({
  videos,
  projects,
  progress,
  onImport,
  onEdit,
  onMerge,
}: {
  videos: LibraryVideo[];
  projects: VideoProject[];
  progress: Record<string, VideoProgress>;
  onImport: () => void;
  onEdit: (ids: string[]) => void;
  onMerge: (ids: string[]) => void;
}) {
  const [sel, setSel] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const ready = videos.filter((v) => v.status === "ready");
  const readyKey = ready.map((v) => v.id).join(",");
  // Forget ticks on videos that went away.
  useEffect(() => setSel((cur) => cur.filter((id) => readyKey.split(",").includes(id))), [readyKey]);

  const usedBy = (id: string) => projects.filter((p) => p.meetingId === null && p.spec.segments.some((s) => s.clipId === id)).length;
  const remove = (v: LibraryVideo) => {
    if (v.status === "error") return void window.vd.invoke("video:deleteImported", v.id);
    const n = usedBy(v.id);
    const also = n ? ` ${n} edit${n === 1 ? " uses" : "s use"} it and will be deleted too.` : "";
    if (confirm(`Remove "${v.title}" from the library?${also} The original file on your computer is not touched.`)) {
      void window.vd.invoke("video:deleteImported", v.id);
    }
  };

  return (
    <section className="mt-8">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold">Imported videos</h2>
        {ready.length > 1 && (
          <Button className="h-7 px-2" disabled={sel.length < 2} title={sel.length < 2 ? "Tick two or more videos to merge them" : undefined} onClick={() => onMerge(sel)}>
            {sel.length >= 2 ? `Merge ${sel.length} selected…` : "Merge selected…"}
          </Button>
        )}
        <Button className="h-7 px-2" variant="primary" onClick={onImport}>
          Import videos…
        </Button>
      </div>
      {videos.length === 0 ? (
        <button onClick={onImport} className="w-full rounded-lg border border-dashed border-line p-6 text-center text-sm text-fg-muted hover:border-accent hover:text-fg">
          <span className="mb-1 block font-medium text-fg">Import a video to edit it</span>
          Click here, or drop video files anywhere on this page. MP4, MOV, WebM, MKV, AVI, WMV and more, including phone videos.
        </button>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
          {videos.map((v) => {
            const live = progress[v.id];
            return (
              <li key={v.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                {ready.length > 1 && (
                  <input
                    type="checkbox"
                    aria-label={`Select ${v.title}`}
                    disabled={v.status !== "ready"}
                    checked={sel.includes(v.id)}
                    onChange={() => setSel((cur) => (cur.includes(v.id) ? cur.filter((x) => x !== v.id) : [...cur, v.id]))}
                  />
                )}
                <div className="min-w-0 flex-1">
                  {renaming?.id === v.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void window.vd.invoke("video:renameImported", v.id, renaming.title);
                        setRenaming(null);
                      }}
                    >
                      <Input
                        autoFocus
                        aria-label="Video name"
                        className="h-7"
                        value={renaming.title}
                        onChange={(e) => setRenaming({ id: v.id, title: e.target.value })}
                        onBlur={() => setRenaming(null)}
                        onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                      />
                    </form>
                  ) : (
                    <div className="truncate">{v.title}</div>
                  )}
                  <div className="truncate text-xs text-fg-muted">
                    {v.status === "ready" && `${clock(v.durationMs ?? 0)} · ${v.width}×${v.height}${v.hasAudio ? "" : " · no sound"} · ${v.originalName}`}
                    {v.status === "error" && <span className="text-red-600 dark:text-red-400">{v.error}</span>}
                    {v.status === "importing" && `Importing ${v.originalName}… ${live ? `${Math.round(live.fraction * 100)}%` : ""}`}
                  </div>
                </div>
                {v.status === "importing" && (
                  <>
                    <div className="h-1.5 w-28 overflow-hidden rounded bg-muted">
                      <div className="h-full bg-accent transition-all" style={{ width: `${Math.round((live?.fraction ?? 0) * 100)}%` }} />
                    </div>
                    <Button className="h-7 px-2" variant="ghost" onClick={() => void window.vd.invoke("video:cancel", v.id)}>
                      Cancel
                    </Button>
                  </>
                )}
                {v.status === "ready" && (
                  <>
                    <Badge>{CLIP_KIND.imported}</Badge>
                    <Button className="h-7 px-2" variant="ghost" onClick={() => setRenaming({ id: v.id, title: v.title })}>
                      Rename
                    </Button>
                    <Button className="h-7 px-2" onClick={() => onEdit([v.id])}>
                      Edit
                    </Button>
                  </>
                )}
                {v.status !== "importing" && (
                  <Button className="h-7 px-2" variant="ghost" onClick={() => remove(v)}>
                    {v.status === "error" ? "Dismiss" : "Remove"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
