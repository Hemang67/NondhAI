import { useEffect, useState } from "react";
import type { SearchHit } from "@shared/notes";
import { Badge, Input } from "../components/ui";
import { clock, useNav } from "../nav";

export function SearchPage({ initialQuery }: { initialQuery: string }) {
  const [q, setQ] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const nav = useNav();

  useEffect(() => {
    if (!q.trim()) return setHits(null);
    const t = setTimeout(() => void window.vd.invoke("search:query", q).then(setHits), 200);
    return () => clearTimeout(t);
  }, [q]);

  const open = (h: SearchHit) => {
    if (h.kind === "meeting") nav({ tab: "meetings", meetingId: h.id, at: h.at });
    else if (h.kind === "note") nav({ tab: "notes", noteId: h.id });
    else nav({ tab: "history" });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="mb-3 text-lg font-semibold">Search</h1>
        <Input type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search meetings, notes and dictations…" aria-label="Search" />
        <p className="mt-2 text-xs text-fg-muted">Matches words and meaning (local embeddings), so “budget concerns” also finds “we can't afford it”.</p>
        <ul className="mt-4 space-y-2">
          {hits?.length === 0 && <li className="text-sm text-fg-muted">No results.</li>}
          {hits?.map((h) => (
            <li key={`${h.kind}:${h.id}`}>
              <button onClick={() => open(h)} className="w-full rounded-lg border border-line bg-panel p-3 text-left hover:bg-muted/50">
                <div className="flex items-center gap-2">
                  <Badge tone={h.kind === "meeting" ? "accent" : "neutral"}>{h.kind}</Badge>
                  <span className="truncate text-sm font-medium">{h.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-fg-muted">
                    {new Date(h.date).toLocaleDateString()}
                    {h.at !== undefined && ` · ${clock(h.at)}`}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-fg-muted">{h.snippet}</p>
                <span className="text-[11px] text-fg-muted">{h.via === "both" ? "words + meaning" : h.via === "semantic" ? "by meaning" : "by words"}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
