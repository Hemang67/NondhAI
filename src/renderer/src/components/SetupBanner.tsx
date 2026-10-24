import { useEffect, useState } from "react";
import type { ModelInfo, SetupStatus } from "@shared/types";
import { APP_NAME } from "@shared/brand";
import { Button } from "./ui";

const size = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);

/**
 * First-run setup: shows the models this computer still needs (downloaded automatically at
 * start-up) until they're all installed, so a fresh install never looks broken.
 */
export function SetupBanner() {
  const [status, setStatus] = useState<SetupStatus | null>(null);

  useEffect(() => {
    const load = () => void window.vd.invoke("models:setup").then(setStatus);
    load();
    const offModels = window.vd.on("models:changed", load);
    // Changing the speech engine or local model can add a model to download.
    const timer = setInterval(load, 5000);
    return () => {
      offModels();
      clearInterval(timer);
    };
  }, []);

  if (!status || status.ready) return null;
  const pending = status.models.filter((m) => !m.installed);
  const busy = pending.some((m) => m.downloading);
  const failed = pending.some((m) => m.error);
  const totalMb = pending.reduce((n, m) => n + m.sizeMb, 0);

  return (
    <section className="border-b border-line bg-panel px-6 py-4" aria-label="Setup">
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Setting up {APP_NAME}</h2>
            <p className="text-xs text-fg-muted">
              Downloading the speech and AI models this computer needs ({size(totalMb)} left, one time only). Everything runs offline once
              they're installed. You can keep using the app meanwhile.
            </p>
          </div>
          {failed && !busy && (
            <Button variant="primary" onClick={() => void window.vd.invoke("models:setupRetry")}>
              Retry download
            </Button>
          )}
        </div>
        <ul className="flex flex-col gap-2">
          {pending.map((m) => (
            <SetupRow key={m.id} m={m} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function SetupRow({ m }: { m: ModelInfo }) {
  const pct = m.downloading ? Math.min(100, Math.round((m.downloading.received / m.downloading.total) * 100)) : 0;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate font-medium">{m.name}</span>
        <span className={m.error ? "shrink-0 text-warn" : "shrink-0 text-fg-muted"}>
          {m.error ? `Failed: ${m.error}` : m.downloading ? `${pct}% of ${size(m.sizeMb)}` : `Waiting · ${size(m.sizeMb)}`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-label={m.name} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </li>
  );
}
