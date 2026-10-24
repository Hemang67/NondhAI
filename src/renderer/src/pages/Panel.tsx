import { useEffect, useState } from "react";
import type { Settings } from "@shared/settings";
import type { RecordingState } from "@shared/ipc";
import { APP_NAME, TAGLINE, TAGLINE_MEANING } from "@shared/brand";
import { cx, Input } from "../components/ui";
import { SetupBanner } from "../components/SetupBanner";
import { NavContext, type NavTarget, type Tab } from "../nav";
import { HistoryPage } from "./HistoryPage";
import { DictionaryPage } from "./DictionaryPage";
import { ModelsPage } from "./ModelsPage";
import { SettingsPage } from "./SettingsPage";
import { MeetingsPage } from "./MeetingsPage";
import { CalendarPage } from "./CalendarPage";
import { NotesPage } from "./NotesPage";
import { SearchPage } from "./SearchPage";
import { PeoplePage } from "./PeoplePage";
import { LibraryPage } from "./video/LibraryPage";
import { VideoEditor } from "./video/VideoEditor";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "meetings", label: "Meetings" },
  { id: "calendar", label: "Calendar" },
  { id: "library", label: "Video library" },
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
            <div className="min-w-0 leading-tight">
              <div className="font-semibold">{APP_NAME}</div>
              <div className="truncate text-[11px] italic text-fg-muted" title={TAGLINE_MEANING}>
                {TAGLINE}
              </div>
            </div>
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
          <Shortcuts refreshKey={nav.tab} />
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <SetupBanner />
          <main className="min-h-0 flex-1 overflow-hidden">
            {nav.tab === "meetings" && <MeetingsPage key={nav.meetingId ?? "list"} initialId={nav.meetingId} at={nav.at} />}
            {nav.tab === "calendar" && <CalendarPage />}
            {nav.tab === "library" &&(nav.projectId ? <VideoEditor key={nav.projectId} id={nav.projectId} /> : <LibraryPage />)}
            {nav.tab === "notes" && <NotesPage initialId={nav.noteId} />}
            {nav.tab === "search" && <SearchPage key={nav.query} initialQuery={nav.query ?? ""} />}
            {!["meetings", "calendar", "library", "notes", "search"].includes(nav.tab) && (
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
      </div>
    </NavContext.Provider>
  );
}

const KEY_LABELS: Record<string, string> = { ctrl: "Ctrl", control: "Ctrl", win: "Win", alt: "Alt", shift: "Shift", space: "Space" };

/** "ctrl+win+t" → ["Ctrl", "Win", "T"] */
const keysOf = (combo: string) => combo.split("+").filter(Boolean).map((k) => KEY_LABELS[k] ?? k.toUpperCase());

/** The global shortcuts, as currently set in Settings → Hotkeys. */
function Shortcuts({ refreshKey }: { refreshKey: string }) {
  const [hotkeys, setHotkeys] = useState<Settings["hotkeys"] | null>(null);
  useEffect(() => {
    void window.vd.invoke("settings:get").then((s) => setHotkeys(s.hotkeys));
  }, [refreshKey]);
  if (!hotkeys) return null;
  const rows: Array<[string, string, string?]> = [
    ["Dictate", hotkeys.dictate, "Hold to talk, or double-tap to keep it on"],
    ["Translate", hotkeys.translate],
    ["Assistant", hotkeys.assistant],
    ["Meeting", hotkeys.meeting, "Start or stop recording a meeting"],
  ];
  return (
    <section className="mt-auto rounded-lg border border-line bg-muted/40 p-2.5" aria-labelledby="shortcuts-title">
      <h2 id="shortcuts-title" className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
        Shortcuts
      </h2>
      <dl className="space-y-1.5">
        {rows.map(([label, combo, hint]) => (
          <div key={label} className="flex items-center justify-between gap-2" title={hint}>
            <dt className="whitespace-nowrap text-xs text-fg-muted">{label}</dt>
            <dd className="flex shrink-0 gap-0.5">
              {keysOf(combo).map((k, i) => (
                <kbd
                  key={i}
                  className="min-w-[1.375rem] rounded border border-line border-b-2 bg-panel px-1 text-center font-sans text-[10px] font-medium leading-4 text-fg"
                >
                  {k}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
