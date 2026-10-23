/**
 * Nondh AI MCP server (stdio). Lets AI assistants such as Claude Code search and read your
 * transcripts, notes and dictations. It talks to the running Nondh AI app through its local
 * API (Settings → Integrations → Local API must be on), so nothing here touches the database
 * directly and encryption at rest keeps working.
 *
 * Run with the app's own executable as Node:
 *   ELECTRON_RUN_AS_NODE=1 "<Nondh AI.exe>" "<resources>\app.asar\out\main\mcp.js"
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function apiConfig(): { url: string; token: string } {
  const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming");
  const file = process.env.NONDH_API_FILE ?? join(appData, "Nondh AI", "api.json");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("Nondh AI's local API is not running. Open Nondh AI → Settings → Integrations and turn on the local API.");
  }
}

async function api(path: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const { url, token } = apiConfig();
  const r = await fetch(`${url}${path}`, {
    method: init?.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Nondh AI API ${r.status}`);
  return j;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const date = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

const server = new McpServer({ name: "nondh", version: "0.1.0" });

server.registerTool(
  "search",
  {
    title: "Search Nondh AI",
    description: "Search meetings, notes and dictations by keywords and meaning. Returns ids to pass to get_meeting / get_note.",
    inputSchema: { query: z.string().describe("What to look for"), limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ query, limit }) => {
    const hits = await api(`/v1/search?q=${encodeURIComponent(query)}&limit=${limit ?? 15}`);
    return json(hits.map((h: any) => ({ kind: h.kind, id: h.id, title: h.title, date: date(h.date), snippet: h.snippet })));
  },
);

server.registerTool(
  "list_meetings",
  {
    title: "List meetings",
    description: "Most recent recorded or imported meetings, newest first.",
    inputSchema: { query: z.string().optional().describe("Optional filter on title or spoken words"), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ query, limit }) => {
    const list = await api(`/v1/meetings?limit=${limit ?? 20}${query ? `&q=${encodeURIComponent(query)}` : ""}`);
    return json(list.map((m: any) => ({ id: m.id, title: m.title, date: date(m.startedAt), minutes: Math.round(m.durationMs / 60000), status: m.status })));
  },
);

server.registerTool(
  "get_meeting",
  {
    title: "Get a meeting",
    description: "Summary (key points, decisions, action items, open questions) and the full speaker-labelled transcript of one meeting.",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => text(await api(`/v1/meetings/${encodeURIComponent(id)}/markdown`).then((r) => r.markdown)),
);

server.registerTool(
  "list_notes",
  {
    title: "List notes",
    description: "Notes, newest first, optionally filtered by text.",
    inputSchema: { query: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ query }) => {
    const notes = await api(`/v1/notes${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    return json(notes.map((n: any) => ({ id: n.id, title: n.title, updated: date(n.updatedAt) })));
  },
);

server.registerTool(
  "get_note",
  { title: "Get a note", description: "The full text of one note.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
  async ({ id }) => {
    const n = await api(`/v1/notes/${encodeURIComponent(id)}`);
    return text(`# ${n.title}\n\n${n.bodyText}`);
  },
);

server.registerTool(
  "recent_dictations",
  {
    title: "Recent dictations",
    description: "Recent dictated text (cleaned), newest first, optionally filtered by text.",
    inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ query, limit }) => {
    const items = await api(`/v1/dictations?limit=${limit ?? 20}${query ? `&q=${encodeURIComponent(query)}` : ""}`);
    return json(items.map((d: any) => ({ date: date(d.createdAt), app: d.appName, text: d.cleanText })));
  },
);

server.registerTool(
  "ask_meetings",
  {
    title: "Ask about meetings",
    description: "Answer a question from Nondh AI's meeting transcripts (uses the language model configured in Nondh AI).",
    inputSchema: { question: z.string(), meetingId: z.string().optional().describe("Limit to one meeting") },
    annotations: { readOnlyHint: true },
  },
  async ({ question, meetingId }) => text((await api("/v1/ask", { method: "POST", body: { question, meetingId } })).answer),
);

server.connect(new StdioServerTransport()).catch((err: unknown) => {
  process.stderr.write(`nondh mcp: ${String(err)}\n`);
  process.exit(1);
});
