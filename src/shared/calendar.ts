/** Calendar events as the app uses them, plus the date maths the Calendar page needs. */
export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  /** Exclusive; all-day events end at the following local midnight. */
  end: number;
  allDay: boolean;
  attendees: string[];
  provider: "google" | "microsoft";
  /** Meet / Zoom / Teams / Webex link, from the conference data or the event text. */
  joinUrl?: string;
  location?: string;
  /** The event in Google Calendar / Outlook on the web. */
  link?: string;
  /** You declined this invitation. */
  declined?: boolean;
  /** A Nondh AI recording made during this event. */
  meetingId?: string;
}

/** A Nondh AI recording shown on the Calendar page. */
export interface CalendarRecording {
  id: string;
  title: string;
  start: number;
  end: number;
}

export interface CalendarRange {
  events: CalendarEvent[];
  /** Recordings in the range that aren't linked to any of `events`. */
  recordings: CalendarRecording[];
  /** Why the calendar couldn't be read (recordings are still listed). */
  error?: string;
}

const CALL_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)meet\.google\.com$/, "Google Meet"],
  [/(^|\.)zoom\.(us|com)$/, "Zoom"],
  [/(^|\.)teams\.(microsoft|live)\.com$/, "Teams"],
  [/(^|\.)webex\.com$/, "Webex"],
];

export function callApp(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return CALL_HOSTS.find(([re]) => re.test(host))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** First video-call link in any of the texts (location, description, ...). */
export function findJoinUrl(texts: Array<string | undefined>): string | undefined {
  for (const t of texts) {
    for (const m of t?.matchAll(/https?:\/\/[^\s"'<>)\]]+/g) ?? []) {
      const url = m[0].replace(/[.,;:!?]+$/, "");
      if (callApp(url)) return url;
    }
  }
  return undefined;
}

const localDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
};

/** A Google Calendar API event resource → CalendarEvent (null for cancelled ones). */
export function fromGoogle(e: Record<string, any>): CalendarEvent | null {
  if (e.status === "cancelled" || !e.start || !e.end) return null;
  const allDay = !e.start.dateTime;
  const attendees: Array<Record<string, any>> = e.attendees ?? [];
  const video = (e.conferenceData?.entryPoints ?? []).find((p: Record<string, any>) => p.entryPointType === "video")?.uri;
  return {
    id: `google:${e.id}`,
    title: e.summary || "(no title)",
    start: allDay ? localDate(e.start.date) : Date.parse(e.start.dateTime),
    end: allDay ? localDate(e.end.date) : Date.parse(e.end.dateTime),
    allDay,
    attendees: attendees.filter((a) => !a.self && !a.resource).map((a) => a.displayName || a.email),
    provider: "google",
    joinUrl: e.hangoutLink || video || findJoinUrl([e.location, e.description]),
    location: e.location || undefined,
    link: e.htmlLink || undefined,
    declined: attendees.some((a) => a.self && a.responseStatus === "declined") || undefined,
  };
}

const DAY_MS = 86400000;
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Local midnight of the Sunday on or before `d`. */
export function weekStart(d: Date): Date {
  return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -d.getDay());
}

/** The 42 days (six Sunday-first weeks) shown for a month; `month` is 0-based. */
export function monthGrid(year: number, month: number): Date[] {
  const first = weekStart(new Date(year, month, 1));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

/** Anything with a time span: calendar events and recordings alike. */
export interface Span {
  start: number;
  end: number;
  allDay?: boolean;
}

export function eventsOnDay<T extends Span>(events: T[], day: Date): T[] {
  const start = day.getTime();
  const end = addDays(day, 1).getTime();
  return events.filter((e) => e.start < end && e.end > start);
}

export interface PlacedEvent<T extends Span = CalendarEvent> {
  event: T;
  /** Minutes from midnight. */
  top: number;
  height: number;
  lane: number;
  lanes: number;
}

/** Week-view placement for one day's timed events: overlapping events share the width. */
export function layoutDay<T extends Span>(events: T[], day: Date): Array<PlacedEvent<T>> {
  const dayStart = day.getTime();
  const sorted = eventsOnDay(events, day)
    .filter((e) => !e.allDay)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Array<PlacedEvent<T>> = [];
  let cluster: Array<PlacedEvent<T>> = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const close = () => {
    for (const p of cluster) p.lanes = laneEnds.length;
    out.push(...cluster);
    cluster = [];
    laneEnds = [];
  };
  for (const e of sorted) {
    if (e.start >= clusterEnd) close();
    let lane = laneEnds.findIndex((end) => end <= e.start);
    if (lane < 0) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = e.end;
    clusterEnd = Math.max(clusterEnd, e.end);
    const top = Math.max(0, (e.start - dayStart) / 60000);
    const bottom = Math.min(DAY_MS / 60000, (e.end - dayStart) / 60000);
    cluster.push({ event: e, top, height: Math.max(15, bottom - top), lane, lanes: 1 });
  }
  close();
  return out;
}
