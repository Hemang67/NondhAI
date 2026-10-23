import { useCallback, useEffect, useState } from "react";
import type { DictationRecord } from "@shared/types";
import { Badge, Button, Input } from "../components/ui";
import { useNav } from "../nav";

export function HistoryPage() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DictationRecord[]>([]);
  const [showRaw, setShowRaw] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const nav = useNav();

  const load = useCallback(() => {
    void window.vd.invoke("history:list", { query, limit: 200 }).then(setItems);
  }, [query]);

  useEffect(() => {
    const t = setTimeout(load, 120);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => window.vd.on("history:changed", load), [load]);

  const copy = async (id: string, which: "clean" | "raw") => {
    await window.vd.invoke("history:copy", id, which);
    setCopied(id + which);
    setTimeout(() => setCopied(null), 1200);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold">Dictations</h1>
        <Button variant="primary" onClick={() => void window.vd.invoke("dictation:toggle")}>
          Start / stop dictation
        </Button>
      </div>
      <Input
        type="search"
        placeholder="Search everything you've dictated…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search history"
      />
      {items.length === 0 && (
        <p className="py-12 text-center text-sm text-fg-muted">
          {query ? "No matches." : "Nothing yet. Hold Ctrl+Win in any app, speak, and release."}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {items.map((d) => {
          const raw = showRaw[d.id];
          return (
            <li key={d.id} className="rounded-lg border border-line bg-panel p-3">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{raw ? d.rawText : d.cleanText}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <time dateTime={new Date(d.createdAt).toISOString()}>{new Date(d.createdAt).toLocaleString()}</time>
                {d.appName && <Badge>{d.appName}</Badge>}
                {d.mode !== "dictate" && <Badge tone="accent">{d.mode}</Badge>}
                {d.cloudUsed && <Badge tone="cloud">cloud</Badge>}
                <span title="Time from releasing the hotkey to the text being pasted">
                  {(d.durationMs / 1000).toFixed(1)}s audio · {(d.latencyMs / 1000).toFixed(2)}s to paste
                </span>
                <span className="ml-auto flex gap-1">
                  <Button variant="ghost" className="h-7 px-2" onClick={() => setShowRaw((s) => ({ ...s, [d.id]: !raw }))} aria-pressed={raw}>
                    {raw ? "Show clean" : "Show raw"}
                  </Button>
                  <Button variant="ghost" className="h-7 px-2" onClick={() => void copy(d.id, raw ? "raw" : "clean")}>
                    {copied === d.id + (raw ? "raw" : "clean") ? "Copied" : "Copy"}
                  </Button>
                  <Button variant="ghost" className="h-7 px-2" onClick={() => void window.vd.invoke("history:toNote", d.id).then((n) => nav({ tab: "notes", noteId: n.id }))}>
                    Make note
                  </Button>
                  <Button variant="ghost" className="h-7 px-2" onClick={() => void window.vd.invoke("history:delete", d.id)} aria-label="Delete">
                    Delete
                  </Button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
