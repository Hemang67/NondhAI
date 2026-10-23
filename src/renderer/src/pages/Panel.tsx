import { useState } from "react";
import { cx } from "../components/ui";
import { HistoryPage } from "./HistoryPage";
import { DictionaryPage } from "./DictionaryPage";
import { ModelsPage } from "./ModelsPage";
import { SettingsPage } from "./SettingsPage";

const TABS = [
  { id: "history", label: "History" },
  { id: "dictionary", label: "Dictionary" },
  { id: "models", label: "Models" },
  { id: "settings", label: "Settings" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function Panel() {
  const [tab, setTab] = useState<Tab>("history");
  return (
    <div className="flex h-full">
      <nav className="flex w-48 shrink-0 flex-col gap-1 border-r border-line bg-panel p-3" aria-label="Sections">
        <div className="mb-4 flex items-center gap-2 px-2 pt-1">
          <img src="./icon.png" alt="" className="size-6" />
          <span className="font-semibold">Nondh AI</span>
        </div>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={cx(
              "rounded-md px-2.5 py-1.5 text-left text-sm",
              tab === t.id ? "bg-muted font-medium" : "text-fg-muted hover:bg-muted hover:text-fg",
            )}
          >
            {t.label}
          </button>
        ))}
        <div className="mt-auto px-2 text-xs leading-relaxed text-fg-muted">
          Hold <kbd className="rounded border border-line px-1">Ctrl</kbd>+<kbd className="rounded border border-line px-1">Win</kbd> to talk, double-tap to lock.
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl p-6">
          {tab === "history" && <HistoryPage />}
          {tab === "dictionary" && <DictionaryPage />}
          {tab === "models" && <ModelsPage />}
          {tab === "settings" && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}
