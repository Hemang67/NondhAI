import type { ApiServer } from "./apiServer";
import { askMeetings, meetingMarkdown, type AppContext } from "../ipc";
import { toSrt, toText, toVtt } from "@shared/meeting/export";

/** Local API (see docs/API.md). Mirrors what the app UI can read, plus meeting start/stop. */
export function registerApiRoutes(api: ApiServer, ctx: AppContext): void {
  const { meetings, notes, store } = ctx;
  const limit = (q: URLSearchParams, def: number) => Math.min(500, Number(q.get("limit") ?? def) || def);

  api
    .route("GET", "/v1/health", () => ({ ok: true, recording: ctx.meetingService.recording }))
    .route("GET", "/v1/search", ({ query }) => ctx.search.search(query.get("q") ?? "", { limit: limit(query, 20) }))
    .route("GET", "/v1/meetings", ({ query }) => meetings.list({ query: query.get("q") ?? undefined, limit: limit(query, 50) }))
    .route("GET", "/v1/meetings/:id", ({ params }) => {
      const m = meetings.get(params.id!);
      if (!m) return null;
      return {
        ...m,
        speakers: meetings.speakers(m.id).map(({ embedding: _e, ...s }) => s),
        transcript: meetings.lines(m.id),
      };
    })
    .route("GET", "/v1/meetings/:id/markdown", ({ params }) => {
      const md = meetingMarkdown(ctx, params.id!);
      return md === null ? null : { markdown: md };
    })
    .route("GET", "/v1/meetings/:id/transcript", ({ params, query }) => {
      const m = meetings.get(params.id!);
      if (!m) return null;
      const speakers = Object.fromEntries(meetings.speakers(m.id).map((s) => [s.key, { name: s.name }]));
      const input = { title: m.title, startedAt: m.startedAt, durationMs: m.durationMs, lines: meetings.lines(m.id), speakers };
      const f = query.get("format") ?? "txt";
      return f === "srt" ? toSrt(input) : f === "vtt" ? toVtt(input) : toText(input);
    })
    .route("POST", "/v1/meetings/start", ({ body }) => ctx.startMeeting({ kind: body?.kind === "room" ? "room" : "call", title: body?.title }))
    .route("POST", "/v1/meetings/stop", async () => ({ id: await ctx.meetingService.stop() }))
    .route("POST", "/v1/meetings/import", async ({ body }) => ({ ids: await ctx.meetingService.importFiles(Array.isArray(body?.paths) ? body.paths : []) }))
    .route("POST", "/v1/ask", ({ body }) => askMeetings(ctx, body?.meetingId ?? null, String(body?.question ?? "")))
    .route("GET", "/v1/notes", ({ query }) => notes.list({ query: query.get("q") ?? undefined }))
    .route("GET", "/v1/notes/:id", ({ params }) => notes.get(params.id!))
    .route("POST", "/v1/notes", ({ body }) => {
      const n = notes.create({ title: body?.title, bodyText: String(body?.text ?? "") });
      ctx.broadcast("notes:changed");
      return n;
    })
    .route("GET", "/v1/dictations", ({ query }) => store.listDictations({ query: query.get("q") ?? undefined, limit: limit(query, 50) }));
}
