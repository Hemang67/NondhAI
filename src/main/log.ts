import { appendFileSync, mkdirSync } from "node:fs";
import { app } from "electron";
import { join } from "node:path";

let file: string | null = null;

function write(level: string, args: unknown[]): void {
  const line =
    `${new Date().toISOString()} ${level} ` +
    args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  (level === "ERROR" ? console.error : console.log)(line);
  try {
    if (!file) {
      const dir = join(app.getPath("userData"), "logs");
      mkdirSync(dir, { recursive: true });
      file = join(dir, "nondh.log");
    }
    appendFileSync(file, line + "\n");
  } catch {
    // logging must never throw
  }
}

export const log = {
  info: (...a: unknown[]) => write("INFO", a),
  warn: (...a: unknown[]) => write("WARN", a),
  error: (...a: unknown[]) => write("ERROR", a),
};
