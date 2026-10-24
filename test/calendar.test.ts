import { describe, expect, it } from "vitest";
import { callApp, eventsOnDay, findJoinUrl, fromGoogle, layoutDay, monthGrid, weekStart, type CalendarEvent } from "@shared/calendar";

const ev = (id: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  title: id,
  start: new Date(start).getTime(),
  end: new Date(end).getTime(),
  allDay: false,
  attendees: [],
  provider: "google",
  ...extra,
});

describe("findJoinUrl / callApp", () => {
  it("finds Meet, Zoom and Teams links in free text", () => {
    expect(findJoinUrl(["Dial in: https://us02web.zoom.us/j/123456?pwd=abc. Thanks"])).toBe("https://us02web.zoom.us/j/123456?pwd=abc");
    expect(findJoinUrl([undefined, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=y"])).toMatch(/^https:\/\/teams\.microsoft\.com\//);
    expect(findJoinUrl(["Room 4", "https://example.com/agenda"])).toBeUndefined();
  });

  it("names the call app", () => {
    expect(callApp("https://meet.google.com/abc-defg-hij")).toBe("Google Meet");
    expect(callApp("https://zoom.us/j/1")).toBe("Zoom");
    expect(callApp("https://teams.live.com/meet/1")).toBe("Teams");
    expect(callApp(undefined)).toBeNull();
  });
});

describe("fromGoogle", () => {
  it("maps a timed event with its Meet link, attendees and Google link", () => {
    const e = fromGoogle({
      id: "a1",
      summary: "Weekly sync",
      start: { dateTime: "2026-10-26T10:00:00+05:30" },
      end: { dateTime: "2026-10-26T10:30:00+05:30" },
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      htmlLink: "https://www.google.com/calendar/event?eid=x",
      location: "Online",
      attendees: [{ email: "me@x.com", self: true }, { email: "ana@x.com", displayName: "Ana" }, { email: "room@x.com", resource: true }],
    })!;
    expect(e).toMatchObject({
      id: "google:a1",
      title: "Weekly sync",
      allDay: false,
      joinUrl: "https://meet.google.com/abc-defg-hij",
      link: "https://www.google.com/calendar/event?eid=x",
      location: "Online",
      attendees: ["Ana"],
    });
    expect(e.end - e.start).toBe(30 * 60 * 1000);
  });

  it("maps an all-day event to local midnights (end exclusive)", () => {
    const e = fromGoogle({ id: "h", summary: "Holiday", start: { date: "2026-10-26" }, end: { date: "2026-10-27" } })!;
    expect(e.allDay).toBe(true);
    expect(e.start).toBe(new Date(2026, 9, 26).getTime());
    expect(e.end).toBe(new Date(2026, 9, 27).getTime());
  });

  it("drops cancelled events and finds Zoom links in the description", () => {
    expect(fromGoogle({ id: "c", status: "cancelled", start: { dateTime: "2026-10-26T10:00:00Z" }, end: { dateTime: "2026-10-26T11:00:00Z" } })).toBeNull();
    const z = fromGoogle({ id: "z", start: { dateTime: "2026-10-26T10:00:00Z" }, end: { dateTime: "2026-10-26T11:00:00Z" }, description: "<a href=\"https://zoom.us/j/99\">Join</a>" })!;
    expect(z.title).toBe("(no title)");
    expect(z.joinUrl).toBe("https://zoom.us/j/99");
  });

  it("marks events you declined", () => {
    const d = fromGoogle({ id: "d", start: { dateTime: "2026-10-26T10:00:00Z" }, end: { dateTime: "2026-10-26T11:00:00Z" }, attendees: [{ email: "me@x.com", self: true, responseStatus: "declined" }] })!;
    expect(d.declined).toBe(true);
  });
});

describe("monthGrid / weekStart", () => {
  it("covers six weeks starting on the Sunday on or before the 1st", () => {
    const days = monthGrid(2026, 9); // October 2026 starts on a Thursday
    expect(days).toHaveLength(42);
    expect(days[0]).toEqual(new Date(2026, 8, 27));
    expect(days[4]).toEqual(new Date(2026, 9, 1));
    expect(days[41]).toEqual(new Date(2026, 10, 7));
  });

  it("finds the Sunday of a week", () => {
    expect(weekStart(new Date(2026, 9, 24, 15, 30))).toEqual(new Date(2026, 9, 18));
    expect(weekStart(new Date(2026, 9, 18))).toEqual(new Date(2026, 9, 18));
  });
});

describe("eventsOnDay", () => {
  it("includes events overlapping the day, multi-day all-day events on each day, not ones ending at midnight", () => {
    const day = new Date(2026, 9, 26);
    const trip = { ...ev("trip", "2026-10-25T00:00", "2026-10-28T00:00"), allDay: true };
    const late = ev("late", "2026-10-25T23:00", "2026-10-26T01:00");
    const prev = ev("prev", "2026-10-25T22:00", "2026-10-26T00:00");
    expect(eventsOnDay([trip, late, prev], day).map((e) => e.id)).toEqual(["trip", "late"]);
  });
});

describe("layoutDay", () => {
  it("puts overlapping events side by side and clips to the day", () => {
    const day = new Date(2026, 9, 26);
    const out = layoutDay(
      [ev("a", "2026-10-26T09:00", "2026-10-26T10:00"), ev("b", "2026-10-26T09:30", "2026-10-26T10:30"), ev("c", "2026-10-26T11:00", "2026-10-26T11:15")],
      day,
    );
    const by = Object.fromEntries(out.map((o) => [o.event.id, o]));
    expect(by.a).toMatchObject({ top: 540, height: 60, lane: 0, lanes: 2 });
    expect(by.b).toMatchObject({ top: 570, height: 60, lane: 1, lanes: 2 });
    // c doesn't overlap anything: full width, but at least 15 minutes tall
    expect(by.c).toMatchObject({ top: 660, height: 15, lane: 0, lanes: 1 });
  });
});
