import { useEffect, useRef, useState } from "react";
import type { PersonRecord } from "@shared/types";
import { Badge, Button, Card, Input } from "../components/ui";
import { Recorder } from "../recorder";

const PARAGRAPH =
  "I'm setting up Nondh AI so it can recognize my voice in meetings. The quick brown fox jumps over the lazy dog. " +
  "On Monday mornings we usually review the numbers, agree on next steps, and decide who owns each task. " +
  "If something is unclear, I'll ask a question and we'll come back to it before the end of the call.";

export function PeoplePage() {
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const load = () => void window.vd.invoke("people:list").then(setPeople);
  useEffect(load, []);
  useEffect(() => window.vd.on("people:changed", load), []);
  const me = people.find((p) => p.isMe);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">People & voices</h1>
      <Enrollment me={me} onDone={load} />
      <Card
        title="People Nondh AI knows"
        description="Name a speaker in any meeting and their voice is remembered here, so later meetings label them automatically. Voice fingerprints never leave this computer."
      >
        {people.filter((p) => !p.isMe).length === 0 ? (
          <p className="text-sm text-fg-muted">Nobody yet. Open a meeting and type a name next to “Speaker 1”.</p>
        ) : (
          <ul className="divide-y divide-line">
            {people
              .filter((p) => !p.isMe)
              .map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2">
                  <input
                    className="flex-1 bg-transparent text-sm outline-none focus:underline"
                    defaultValue={p.name}
                    aria-label={`Name of ${p.name}`}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && void window.vd.invoke("people:rename", p.id, e.target.value)}
                  />
                  <span className="text-xs text-fg-muted">
                    {p.voiceprints} voice sample{p.voiceprints === 1 ? "" : "s"}
                  </span>
                  <Button variant="ghost" className="h-7 px-2" onClick={() => confirm(`Forget ${p.name}'s voice?`) && void window.vd.invoke("people:delete", p.id)}>
                    Forget
                  </Button>
                </li>
              ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Enrollment({ me, onDone }: { me?: PersonRecord; onDone: () => void }) {
  const [name, setName] = useState(me?.name ?? "");
  const [state, setState] = useState<"idle" | "recording" | "saving" | "done" | "error">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [level, setLevel] = useState(0);
  const chunks = useRef<Float32Array[]>([]);
  const rec = useRef<Recorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => setName((n) => n || me?.name || ""), [me?.name]);

  const start = async () => {
    chunks.current = [];
    setError("");
    setSeconds(0);
    rec.current = new Recorder(
      (_id, s) => chunks.current.push(s),
      (rms) => setLevel(Math.min(1, rms * 8)),
    );
    try {
      await rec.current.start("enroll");
      setState("recording");
      const t0 = Date.now();
      timer.current = setInterval(() => setSeconds(Math.floor((Date.now() - t0) / 1000)), 250);
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  const stop = async () => {
    if (timer.current) clearInterval(timer.current);
    await rec.current?.stop();
    const total = chunks.current.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total);
    let off = 0;
    for (const c of chunks.current) {
      all.set(c, off);
      off += c.length;
    }
    setState("saving");
    try {
      await window.vd.invoke("people:enroll", name.trim() || "Me", all);
      setState("done");
      onDone();
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      setState("error");
    }
  };

  return (
    <Card
      title="Your voice"
      description="Read the paragraph below once. Nondh AI stores a voice fingerprint on this computer, so it can tell it's you in in-person meetings and imported recordings. In calls, your microphone already identifies you."
      actions={me && me.voiceprints > 0 ? <Badge tone="accent">enrolled</Badge> : <Badge>not enrolled</Badge>}
    >
      <label className="mb-3 flex max-w-xs flex-col gap-1 text-xs text-fg-muted">
        Your name
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
      </label>
      <blockquote className="rounded-md border border-line bg-muted p-3 text-sm leading-relaxed">{PARAGRAPH}</blockquote>
      <div className="mt-3 flex items-center gap-3">
        {state === "recording" ? (
          <>
            <Button variant="danger" onClick={() => void stop()} disabled={seconds < 8}>
              {seconds < 8 ? `Keep reading… ${seconds}s` : "Done"}
            </Button>
            <div className="h-1.5 w-32 overflow-hidden rounded bg-muted" aria-hidden>
              <div className="h-full bg-accent" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
          </>
        ) : (
          <Button variant="primary" onClick={() => void start()} disabled={state === "saving"}>
            {state === "saving" ? "Saving…" : me && me.voiceprints > 0 ? "Record again" : "Start reading"}
          </Button>
        )}
        {state === "done" && <span className="text-sm">Saved. Re-process older meetings to apply it.</span>}
        {state === "error" && <span className="text-sm text-warn">{error}</span>}
      </div>
    </Card>
  );
}
