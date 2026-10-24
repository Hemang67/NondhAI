import { useCallback, useEffect, useRef, useState } from "react";
import { addDays, callApp, eventsOnDay, layoutDay, monthGrid, weekStart, type CalendarEvent, type CalendarRange, type CalendarRecording } from "@shared/calendar";
import { Badge, Button, cx } from "../components/ui";
import { fmtDuration, useNav } from "../nav";

type View = "month" | "week" | "list";
type ListMode = "past" | "today" | "upcoming";
const LIST_DAYS = 30;
type Status = { google: boolean; microsoft: boolean; googleBuiltIn: boolean; googleAccount: string | null };

/** One thing on the calendar: a calendar event or a recording no event links to. */
interface Item {
  key: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  kind: "recorded" | "call" | "event";
  declined: boolean;
  event?: CalendarEvent;
  recording?: CalendarRecording;
}

const KIND_STYLE: Record<Item["kind"], string> = {
  recorded: "bg-emerald-700 text-white",
  call: "bg-sky-700 text-white",
  event: "bg-slate-600 text-white",
};
const LEGEND: Array<[Item["kind"], string]> = [
  ["recorded", "Recorded in Nondh AI"],
  ["call", "Online call"],
  ["event", "Event"],
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_PX = 48;
const MAX_CHIPS = 3;

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const midnight = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

function toItems(data: CalendarRange | null): Item[] {
  if (!data) return [];
  const events: Item[] = data.events.map((e) => ({
    key: e.id,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    kind: e.meetingId ? "recorded" : e.joinUrl ? "call" : "event",
    declined: !!e.declined,
    event: e,
  }));
  const recordings: Item[] = data.recordings.map((r) => ({
    key: `rec:${r.id}`,
    title: r.title,
    start: r.start,
    end: Math.max(r.end, r.start + 60000),
    allDay: false,
    kind: "recorded",
    declined: false,
    recording: r,
  }));
  // All-day first, then by start time.
  return [...events, ...recordings].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
}

export function CalendarPage() {
  const [view, setView] = useState<View>(() => {
    try {
      const v = localStorage.getItem("calendar.view");
      return v === "week" || v === "list" ? v : "month";
    } catch {
      return "month";
    }
  });
  const [listMode, setListMode] = useState<ListMode>("today");
  const [anchor, setAnchor] = useState(midnight);
  const [data, setData] = useState<CalendarRange | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [dayList, setDayList] = useState<Date | null>(null);
  const [connectError, setConnectError] = useState("");
  const request = useRef(0);

  const today = midnight();
  const days =
    view === "month"
      ? monthGrid(anchor.getFullYear(), anchor.getMonth())
      : view === "week"
        ? Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i))
        : listMode === "past"
          ? [addDays(today, -LIST_DAYS), today]
          : listMode === "today"
            ? [today]
            : [today, addDays(today, LIST_DAYS)];
  const from = days[0]!.getTime();
  const to = addDays(days[days.length - 1]!, 1).getTime();

  const load = useCallback(() => {
    const id = ++request.current;
    setLoading(true);
    void window.vd
      .invoke("calendar:events", from, to)
      .then((r) => id === request.current && setData(r))
      .finally(() => id === request.current && setLoading(false));
  }, [from, to]);
  const loadStatus = () => void window.vd.invoke("calendar:status").then(setStatus);

  useEffect(load, [load]);
  useEffect(() => {
    loadStatus();
    const t = setInterval(load, 5 * 60 * 1000);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem("calendar.view", v);
    } catch {
      // per-viewer convenience only
    }
  };
  const step = (dir: 1 | -1) =>
    setAnchor((a) => (view === "month" ? new Date(a.getFullYear(), a.getMonth() + dir, 1) : addDays(a, 7 * dir)));

  const connect = async () => {
    setConnectError("");
    try {
      await window.vd.invoke("calendar:connect", "google");
      loadStatus();
      load();
    } catch (e) {
      setConnectError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  const disconnect = async () => {
    await window.vd.invoke("calendar:disconnect", "google");
    loadStatus();
    load();
  };

  const items = toItems(data);
  const title =
    view === "month"
      ? anchor.toLocaleDateString([], { month: "long", year: "numeric" })
      : view === "week"
        ? `${days[0]!.toLocaleDateString([], { day: "numeric", month: "short" })} – ${days[6]!.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}`
        : { past: `Last ${LIST_DAYS} days`, today: today.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }), upcoming: `Next ${LIST_DAYS} days` }[listMode];

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        {view === "list" ? (
          <div className="flex" role="group" aria-label="Which meetings">
            {(["past", "today", "upcoming"] as const).map((m, i) => (
              <Button
                key={m}
                variant={listMode === m ? "primary" : "secondary"}
                aria-pressed={listMode === m}
                className={cx(i > 0 && "-ml-px rounded-l-none", i < 2 && "rounded-r-none", "capitalize")}
                onClick={() => setListMode(m)}
              >
                {m}
              </Button>
            ))}
          </div>
        ) : (
          <>
            <div className="flex">
              <Button className="rounded-r-none" aria-label={view === "month" ? "Previous month" : "Previous week"} onClick={() => step(-1)}>
                ‹
              </Button>
              <Button className="-ml-px rounded-l-none" aria-label={view === "month" ? "Next month" : "Next week"} onClick={() => step(1)}>
                ›
              </Button>
            </div>
            <Button onClick={() => setAnchor(midnight())}>Today</Button>
          </>
        )}
        <h1 className="min-w-0 flex-1 text-center text-lg font-semibold">{title}</h1>
        <Button variant="ghost" onClick={load} disabled={loading} title="Refresh">
          {loading ? "Loading…" : "Refresh"}
        </Button>
        <div className="flex" role="group" aria-label="View">
          {(["month", "week", "list"] as const).map((v, i) => (
            <Button
              key={v}
              variant={view === v ? "primary" : "secondary"}
              aria-pressed={view === v}
              className={cx(i > 0 && "-ml-px rounded-l-none", i < 2 && "rounded-r-none", "capitalize")}
              onClick={() => changeView(v)}
            >
              {v}
            </Button>
          ))}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-xs text-fg-muted">
        {LEGEND.map(([k, label]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={cx("size-2.5 rounded-full", KIND_STYLE[k])} aria-hidden /> {label}
          </span>
        ))}
        <span className="flex-1" />
        {status?.google ? (
          <span className="flex items-center gap-2">
            Google Calendar{status.googleAccount ? ` · ${status.googleAccount}` : ""}
            <button className="text-accent hover:underline" onClick={() => void disconnect()}>
              Disconnect
            </button>
          </span>
        ) : (
          status && (
            <span className="flex items-center gap-2">
              Showing your recordings only.
              <Button variant="primary" className="h-7" onClick={() => void connect()}>
                Connect Google Calendar
              </Button>
            </span>
          )
        )}
      </div>
      {(connectError || data?.error) && (
        <p className="mx-4 mb-2 rounded-md border border-line bg-panel px-3 py-2 text-sm text-warn">
          {connectError || `Couldn't read your calendar: ${data?.error}`}
        </p>
      )}

      {view === "month" ? (
        <MonthView days={days} month={anchor.getMonth()} items={items} onOpen={setSelected} onMore={setDayList} />
      ) : view === "week" ? (
        <WeekView days={days} items={items} onOpen={setSelected} />
      ) : (
        <ListView from={from} to={to} items={items} newestFirst={listMode === "past"} loading={loading && !data} onOpen={setSelected} />
      )}

      {dayList && (
        <Dialog label={dayList.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })} onClose={() => setDayList(null)}>
          <ul className="flex flex-col gap-1">
            {eventsOnDay(items, dayList).map((it) => (
              <li key={it.key}>
                <Chip item={it} onOpen={(i) => (setDayList(null), setSelected(i))} />
              </li>
            ))}
          </ul>
        </Dialog>
      )}
      {selected && <Details item={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Chip({ item, onOpen }: { item: Item; onOpen: (i: Item) => void }) {
  return (
    <button
      onClick={() => onOpen(item)}
      title={item.title}
      className={cx(
        "block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] leading-4",
        KIND_STYLE[item.kind],
        item.declined && "line-through opacity-50",
        item.allDay && "font-semibold",
      )}
    >
      {!item.allDay && <span className="opacity-80">{time(item.start)} </span>}
      {item.title}
    </button>
  );
}

function MonthView({ days, month, items, onOpen, onMore }: { days: Date[]; month: number; items: Item[]; onOpen: (i: Item) => void; onMore: (d: Date) => void }) {
  const today = new Date();
  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
      <div className="grid grid-cols-7 overflow-hidden rounded-t-md bg-slate-700 text-center text-xs font-semibold text-white">
        {WEEKDAYS.map((d) => (
          <div key={d} className="py-1.5">
            {d}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 border-l border-t border-line">
        {days.map((d) => {
          const list = eventsOnDay(items, d);
          const weekend = d.getDay() === 0 || d.getDay() === 6;
          const isToday = sameDay(d, today);
          return (
            <div key={d.toISOString()} className={cx("flex min-h-0 flex-col gap-0.5 overflow-hidden border-b border-r border-line p-1", weekend ? "bg-muted" : "bg-panel")}>
              <div className="flex justify-end">
                <span
                  className={cx(
                    "grid size-6 place-items-center rounded-full text-xs",
                    isToday ? "bg-accent font-bold text-accent-fg" : d.getMonth() === month ? "text-fg" : "text-fg-muted opacity-60",
                  )}
                >
                  {d.getDate()}
                </span>
              </div>
              {list.slice(0, MAX_CHIPS).map((it) => (
                <Chip key={it.key} item={it} onOpen={onOpen} />
              ))}
              {list.length > MAX_CHIPS && (
                <button className="text-left text-[11px] text-accent hover:underline" onClick={() => onMore(d)}>
                  +{list.length - MAX_CHIPS} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekView({ days, items, onOpen }: { days: Date[]; items: Item[]; onOpen: (i: Item) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX; // start the view at 7:00
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);
  const today = new Date(now);
  const allDay = days.map((d) => eventsOnDay(items, d).filter((i) => i.allDay));
  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
      <div className="grid grid-cols-[3.5rem_repeat(7,1fr)] rounded-t-md bg-slate-700 text-center text-xs font-semibold text-white">
        <div />
        {days.map((d) => (
          <div key={d.toISOString()} className="py-1.5">
            {WEEKDAYS[d.getDay()]}{" "}
            <span className={cx("inline-grid size-5 place-items-center rounded-full", sameDay(d, today) && "bg-accent text-accent-fg")}>{d.getDate()}</span>
          </div>
        ))}
      </div>
      {allDay.some((l) => l.length) && (
        <div className="grid grid-cols-[3.5rem_repeat(7,1fr)] border-x border-b border-line">
          <div className="p-1 text-right text-[10px] text-fg-muted">all day</div>
          {allDay.map((list, i) => (
            <div key={i} className="flex flex-col gap-0.5 border-l border-line p-0.5">
              {list.map((it) => (
                <Chip key={it.key} item={it} onOpen={onOpen} />
              ))}
            </div>
          ))}
        </div>
      )}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto border-x border-b border-line">
        <div className="relative grid grid-cols-[3.5rem_repeat(7,1fr)]" style={{ height: 24 * HOUR_PX }}>
          <div>
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="relative pr-1 text-right text-[10px] text-fg-muted" style={{ height: HOUR_PX }}>
                <span className="relative -top-1.5">{h === 0 ? "" : time(new Date(2000, 0, 1, h).getTime())}</span>
              </div>
            ))}
          </div>
          {days.map((d) => (
            <div key={d.toISOString()} className={cx("relative border-l border-line", (d.getDay() === 0 || d.getDay() === 6) && "bg-muted")}>
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="border-b border-line/60" style={{ height: HOUR_PX }} />
              ))}
              {layoutDay(items, d).map((p) => (
                <button
                  key={p.event.key}
                  onClick={() => onOpen(p.event)}
                  title={p.event.title}
                  className={cx(
                    "absolute overflow-hidden rounded px-1 py-0.5 text-left text-[11px] leading-4 ring-1 ring-panel",
                    KIND_STYLE[p.event.kind],
                    p.event.declined && "line-through opacity-50",
                  )}
                  style={{
                    top: (p.top / 60) * HOUR_PX,
                    height: Math.max(18, (p.height / 60) * HOUR_PX),
                    left: `${(p.lane / p.lanes) * 100}%`,
                    width: `${100 / p.lanes}%`,
                  }}
                >
                  <div className="truncate font-medium">{p.event.title}</div>
                  <div className="truncate opacity-80">
                    {time(p.event.start)} – {time(p.event.end)}
                  </div>
                </button>
              ))}
              {sameDay(d, today) && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500"
                  style={{ top: ((now - d.getTime()) / 3600000) * HOUR_PX }}
                  aria-hidden
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Past / today / upcoming meetings grouped by day. */
function ListView({ from, to, items, newestFirst, loading, onOpen }: { from: number; to: number; items: Item[]; newestFirst: boolean; loading: boolean; onOpen: (i: Item) => void }) {
  const now = Date.now();
  const groups: Array<{ day: Date; items: Item[] }> = [];
  for (let d = new Date(from); d.getTime() < to; d = addDays(d, 1)) {
    // Past: only what has started; upcoming: hide what's already over (except all-day events today).
    const list = eventsOnDay(items, d).filter((i) => (newestFirst ? i.start <= now : i.end > now || i.allDay));
    if (list.length) groups.push({ day: d, items: newestFirst ? list.reverse() : list });
  }
  if (newestFirst) groups.reverse();
  if (!groups.length) return <p className="p-8 text-center text-sm text-fg-muted">{loading ? "Loading…" : "No meetings."}</p>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {groups.map((g) => (
          <section key={g.day.toISOString()}>
            <h2 className="sticky top-0 bg-bg py-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {sameDay(g.day, new Date()) ? "Today · " : ""}
              {g.day.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
            </h2>
            <ul className="divide-y divide-line rounded-md border border-line bg-panel">
              {g.items.map((it) => (
                <li key={it.key}>
                  <button onClick={() => onOpen(it)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted">
                    <span className={cx("size-2.5 shrink-0 rounded-full", KIND_STYLE[it.kind])} aria-hidden />
                    <span className="w-28 shrink-0 text-xs tabular-nums text-fg-muted">{it.allDay ? "All day" : `${time(it.start)} – ${time(it.end)}`}</span>
                    <span className={cx("min-w-0 flex-1 truncate text-sm", it.declined && "line-through opacity-60")}>{it.title}</span>
                    {it.event && it.event.attendees.length > 0 && <span className="shrink-0 text-xs text-fg-muted">{it.event.attendees.length} guests</span>}
                    {it.event?.joinUrl && <Badge>{callApp(it.event.joinUrl)}</Badge>}
                    {it.kind === "recorded" && <Badge tone="accent">Recorded</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div role="dialog" aria-label={label} className="w-full max-w-md rounded-lg border border-line bg-panel p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-base font-semibold">{label}</h2>
          <Button variant="ghost" className="h-7 px-2" aria-label="Close" onClick={onClose}>
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Details({ item, onClose }: { item: Item; onClose: () => void }) {
  const nav = useNav();
  const [error, setError] = useState("");
  const e = item.event;
  const meetingId = e?.meetingId ?? item.recording?.id;
  const now = Date.now();
  const canRecord = !!e && !e.allDay && !e.meetingId && e.start - 10 * 60 * 1000 <= now && now <= e.end;
  const date = new Date(item.start).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const when = item.allDay
    ? `${date} · All day`
    : `${date} · ${time(item.start)} – ${time(item.end)}`;
  const app = callApp(e?.joinUrl);

  const record = async () => {
    setError("");
    try {
      const state = await window.vd.invoke("meetings:start", { kind: "call", title: item.title });
      onClose();
      nav({ tab: "meetings", meetingId: state.id });
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };

  return (
    <Dialog label={item.title} onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-fg-muted">{when}</p>
        <div className="flex flex-wrap gap-1.5">
          {item.recording && <Badge tone="accent">Recording · {fmtDuration(item.end - item.start)}</Badge>}
          {e?.meetingId && <Badge tone="accent">Recorded in Nondh AI</Badge>}
          {app && <Badge>{app}</Badge>}
          {e?.declined && <Badge tone="cloud">You declined</Badge>}
        </div>
        {e?.location && (
          <p>
            <span className="text-fg-muted">Where: </span>
            {e.location}
          </p>
        )}
        {e && e.attendees.length > 0 && (
          <div>
            <p className="text-fg-muted">{e.attendees.length} {e.attendees.length === 1 ? "guest" : "guests"}</p>
            <p className="mt-0.5">
              {e.attendees.slice(0, 12).join(", ")}
              {e.attendees.length > 12 && ` and ${e.attendees.length - 12} more`}
            </p>
          </div>
        )}
        {error && <p className="text-warn">{error}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          {meetingId && (
            <Button
              variant="primary"
              onClick={() => {
                onClose();
                nav({ tab: "meetings", meetingId });
              }}
            >
              Open meeting
            </Button>
          )}
          {canRecord && (
            <Button variant="primary" onClick={() => void record()}>
              Record
            </Button>
          )}
          {e?.joinUrl && <Button onClick={() => window.open(e.joinUrl)}>Join {app ?? "call"}</Button>}
          {e?.link && <Button onClick={() => window.open(e.link)}>Open in {e.provider === "google" ? "Google Calendar" : "Outlook"}</Button>}
        </div>
      </div>
    </Dialog>
  );
}
