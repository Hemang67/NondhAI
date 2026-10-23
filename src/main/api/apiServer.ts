import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { getSecret, setSecret } from "../secrets";
import { userDataPath } from "../paths";
import { log } from "../log";

export type Handler = (req: { params: Record<string, string>; query: URLSearchParams; body: any }) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

/** The API token, created on first use and kept with DPAPI. */
export function apiToken(): string {
  let t = getSecret("api-token");
  if (!t) {
    t = randomBytes(24).toString("base64url");
    setSecret("api-token", t);
  }
  return t;
}

/**
 * Local HTTP API on 127.0.0.1 only, every request needs `Authorization: Bearer <token>`.
 * The Host header is checked so a web page can't reach it through DNS rebinding. The port and
 * token are also written to <userData>/api.json for local tools (the MCP server) to read.
 */
export class ApiServer {
  private server: Server | null = null;
  private routes: Route[] = [];

  route(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_m, k: string) => (keys.push(k), "([^/]+)"))}$`);
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  start(port: number): Promise<number> {
    this.stop();
    const token = apiToken();
    const tokenBuf = Buffer.from(`Bearer ${token}`);
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res, tokenBuf));
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const actual = (server.address() as { port: number }).port;
        this.server = server;
        writeFileSync(userDataPath("api.json"), JSON.stringify({ url: `http://127.0.0.1:${actual}`, token }, null, 2));
        log.info(`local API listening on 127.0.0.1:${actual}`);
        resolve(actual);
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    rmSync(userDataPath("api.json"), { force: true });
  }

  private async handle(req: IncomingMessage, res: ServerResponse, token: Buffer): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const host = (req.headers.host ?? "").split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") return send(403, { error: "forbidden host" });
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== token.length || !timingSafeEqual(auth, token)) return send(401, { error: "missing or invalid token" });

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
      let body: unknown = null;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return send(400, { error: "invalid JSON body" });
        }
      }
      try {
        const out = await r.handler({ params, query: url.searchParams, body });
        if (out === null || out === undefined) return send(404, { error: "not found" });
        return send(200, out);
      } catch (err) {
        return send(500, { error: (err as Error).message });
      }
    }
    send(404, { error: "no such endpoint" });
  }
}
