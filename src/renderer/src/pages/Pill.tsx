import { useEffect, useRef, useState } from "react";
import type { PillState } from "@shared/types";
import { Recorder } from "../recorder";

const MODE_LABEL = { dictate: "Listening", translate: "Translating", assistant: "Assistant" } as const;

export function Pill() {
  const [state, setState] = useState<PillState>({ kind: "hidden" });
  const [level, setLevel] = useState(0);
  const recorder = useRef<Recorder | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("pill-root");
    const rec = new Recorder(
      (id, samples) => window.vd.send("recorder:chunk", id, samples),
      (rms) => setLevel(Math.min(1, rms * 8)),
    );
    recorder.current = rec;
    const offs = [
      window.vd.on("pill:state", (s) => {
        setState(s);
        if (s.kind !== "listening") setLevel(0);
      }),
      window.vd.on("recorder:start", (id) => {
        rec.start(id).then(
          () => window.vd.send("recorder:started", id, null),
          (err: Error) => window.vd.send("recorder:started", id, err.message || String(err)),
        );
      }),
      window.vd.on("recorder:stop", (id) => {
        void rec.stop().then(() => window.vd.send("recorder:stopped", id));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  if (state.kind === "hidden") return null;

  return (
    <div className="flex h-screen w-screen items-center justify-center p-2">
      <div
        role="status"
        aria-live="polite"
        className="flex h-11 items-center gap-3 rounded-full border border-white/10 bg-neutral-900/95 px-4 text-sm text-neutral-100 shadow-lg shadow-black/40"
      >
        {state.kind === "listening" && (
          <>
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60" />
              <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
            </span>
            <span className="font-medium">{MODE_LABEL[state.mode]}</span>
            <Bars level={level} />
            {state.locked && <span className="text-xs text-neutral-400">tap to stop</span>}
          </>
        )}
        {state.kind === "processing" && (
          <>
            <span className="size-3.5 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
            <span className="font-medium">{state.mode === "translate" ? "Translating…" : "Transcribing…"}</span>
            {state.cloud && (
              <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300" title="Audio or text is being sent to your cloud provider">
                cloud
              </span>
            )}
          </>
        )}
        {state.kind === "error" && <span className="max-w-[220px] truncate text-amber-300">{state.message}</span>}
      </div>
    </div>
  );
}

function Bars({ level }: { level: number }) {
  const weights = [0.5, 0.8, 1, 0.8, 0.5];
  return (
    <span className="flex h-4 items-center gap-0.5" aria-hidden>
      {weights.map((w, i) => (
        <span
          key={i}
          className="w-1 rounded-full bg-sky-400 transition-[height] duration-75"
          style={{ height: `${Math.max(3, Math.round(16 * Math.min(1, level * w * 1.6)))}px` }}
        />
      ))}
    </span>
  );
}
