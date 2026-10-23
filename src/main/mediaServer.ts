import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { log } from "./log";

export interface MediaFile {
  path: string;
  type: string;
  /** Encrypted at rest: served from a decrypted copy in memory instead of streamed from disk. */
  encrypted: boolean;
}

/**
 * Serves meeting audio, screen clips, exported edits and added images to the app's own
 * windows over http://127.0.0.1 with byte ranges, so players can seek and stream them.
 *
 * Chromium's media stack handles ranges reliably only over HTTP: through a custom protocol a
 * player stalls at the end of a partial answer and fails after abandoning a long one. The
 * server listens on loopback only, on a random port, and every URL carries a per-run secret.
 */
export class MediaServer {
  private server: Server | null = null;
  private readonly token = randomBytes(16).toString("hex");
  private host = "";
  base = "";

  constructor(
    private readonly d: {
      resolve: (meetingId: string, parts: string[]) => MediaFile | null;
      decrypt: (path: string) => Buffer;
    },
  ) {}

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        this.host = `127.0.0.1:${port}`;
        this.base = `http://${this.host}/${this.token}`;
        this.server = server;
        resolve(this.base);
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const fail = (status: number) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(String(status));
    };
    // Only this app's windows: exact loopback host (stops DNS-rebinding pages) and the secret.
    if (req.headers.host !== this.host) return fail(403);
    if (req.method !== "GET" && req.method !== "HEAD") return fail(405);
    let parts: string[];
    try {
      parts = new URL(req.url ?? "/", `http://${this.host}`).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return fail(400);
    }
    if (parts[0] !== this.token || !parts[1]) return fail(404);
    const file = this.d.resolve(parts[1], parts.slice(2));
    if (!file) return fail(404);

    try {
      const data = file.encrypted ? this.d.decrypt(file.path) : null;
      const size = data ? data.length : statSync(file.path).size;
      const headers: Record<string, string> = {
        "content-type": file.type,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      };
      let start = 0;
      let end = size - 1;
      let status = 200;
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range && (range[1] || range[2])) {
        start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          res.writeHead(416, { "content-range": `bytes */${size}` });
          return void res.end();
        }
        status = 206;
        headers["content-range"] = `bytes ${start}-${end}/${size}`;
      }
      headers["content-length"] = String(end - start + 1);
      res.writeHead(status, headers);
      if (req.method === "HEAD" || size === 0) return void res.end();
      if (data) res.end(data.subarray(start, end + 1));
      else {
        const stream = createReadStream(file.path, { start, end });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
      }
    } catch (err) {
      log.error("media read failed", err);
      if (!res.headersSent) fail(500);
      else res.destroy();
    }
  }
}
