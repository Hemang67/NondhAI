import { useEffect, useState } from "react";
import type { RecordingState } from "@shared/ipc";
import { cx, Input } from "../components/ui";
import { NavContext, type NavTarget, type Tab } from "../nav";
import { HistoryPage } from "./HistoryPage";
import { DictionaryPage } from "./DictionaryPage";
import { ModelsPage } from "./ModelsPage";
import { SettingsPage } from "./SettingsPage";
import { MeetingsPage } from "./MeetingsPage";
import { NotesPage } from "./NotesPage";
import { SearchPage } from "./SearchPage";
import { PeoplePage } from "./PeoplePage";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "meetings", label: "Meetings" },
  { id: "notes", label: "Notes" },
  { id: "history", label: "Dictations" },
  { id: "people", label: "People & voices" },
  { id: "dictionary", label: "Dictionary" },
  { id: "models", label: "Models" },
  { id: "settings", label: "Settings" },
];

export function Panel() {
  const [nav, setNav] = useState<NavTarget>({ tab: "meetings" });
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<RecordingState | null>(null);

  useEffect(() => {
    void window.vd.invoke("meetings:recording").then(setRecording);
    return window.vd.on("meeting:state", setRecording);
  }, []);

  return (
    <NavContext.Provider value={setNav}>
      <div className="flex h-full">
        <nav className="flex w-52 shrink-0 flex-col gap-1 border-r border-line bg-panel p-3" aria-label="Sections">
          <div className="mb-3 flex items-center gap-2 px-2 pt-1">
            <img src="./icon.png" alt="" className="size-6" />
            <span className="font-semibold">Nondh AI</span>
          </div>
          <form
            className="mb-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) setNav({ tab: "search", query: query.trim() });
            }}
          >
            <Input type="search" placeholder="Search everything…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search everything" />
          </form>
          {recording && (
            <button
              onClick={() => setNav({ tab: "meetings", meetingId: recording.id })}
              className="mb-1 flex items-center gap-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-left text-sm text-red-600 dark:text-red-400"
            >
              <span className="size-2 animate-pulse rounded-full bg-red-500" /> Recording
            </button>
          )}
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setNav({ tab: t.id })}
              aria-current={nav.tab === t.id ? "page" : undefined}
              className={cx(
                "rounded-md px-2.5 py-1.5 text-left text-sm",
                nav.tab === t.id ? "bg-muted font-medium" : "text-fg-muted hover:bg-muted hover:text-fg",
              )}
            >
              {t.label}
            </button>
          ))}
          <div className="mt-auto space-y-1 px-2 text-xs leading-relaxed text-fg-muted">
            <p>
              <kbd className="rounded border border-line px-1">Ctrl</kbd>+<kbd className="rounded border border-line px-1">Win</kbd> dictate
            </p>
            <p>…+<kbd className="rounded border border-line px-1">T</kbd> translate · +<kbd className="rounded border border-line px-1">A</kbd> assistant</p>
            <p>…+<kbd className="rounded border border-line px-1">M</kbd> record meeting</p>
          </div>
        </nav>
        <main className="min-w-0 flex-1 overflow-hidden">
          {nav.tab === "meetings" && <MeetingsPage key={nav.meetingId ?? "list"} initialId={nav.meetingId} at={nav.at} />}
          {nav.tab === "notes" && <NotesPage initialId={nav.noteId} />}
          {nav.tab === "search" && <SearchPage key={nav.query} initialQuery={nav.query ?? ""} />}
          {nav.tab !== "meetings" && nav.tab !== "notes" && nav.tab !== "search" && (
            <div className="h-full overflow-y-auto">
              <div className="mx-auto max-w-4xl p-6">
                {nav.tab === "history" && <HistoryPage />}
                {nav.tab === "people" && <PeoplePage />}
                {nav.tab === "dictionary" && <DictionaryPage />}
                {nav.tab === "models" && <ModelsPage />}
                {nav.tab === "settings" && <SettingsPage />}
              </div>
            </div>
          )}
        </main>
      </div>
    </NavContext.Provider>
  );
}
