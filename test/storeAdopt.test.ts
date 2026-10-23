import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { adoptEarlierDatabase, Store } from "../src/main/storage/store";

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "vd-adopt-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A Chromium-style database that isn't ours. */
function chromiumDb(path: string) {
  const db = new Database(path);
  db.exec("CREATE TABLE entries (k TEXT)");
  db.close();
}

describe("adoptEarlierDatabase", () => {
  it("adopts an earlier plain database with the app's tables, and leaves other databases alone", () => {
    const d = dir();
    chromiumDb(join(d, "declarative_performance_observer.db"));
    const old = new Store(join(d, "earlier.db"));
    old.db.prepare(`INSERT INTO meetings (id, title, kind, status, started_at, dir, created_at, updated_at) VALUES ('m', 'Kept', 'call', 'ready', 0, 'x', 0, 0)`).run();
    old.close();

    adoptEarlierDatabase(join(d, "nondh.db"));
    expect(existsSync(join(d, "earlier.db"))).toBe(false);
    expect(existsSync(join(d, "declarative_performance_observer.db"))).toBe(true);
    const s = new Store(join(d, "nondh.db"));
    expect(s.db.prepare("SELECT title FROM meetings").get()).toEqual({ title: "Kept" });
    s.close();
  });

  it("adopts an encrypted earlier database", () => {
    const d = dir();
    const old = new Store(join(d, "earlier.db"), { key: "secret" });
    old.db.prepare(`INSERT INTO meetings (id, title, kind, status, started_at, dir, created_at, updated_at) VALUES ('m', 'Encrypted', 'call', 'ready', 0, 'x', 0, 0)`).run();
    old.close();
    adoptEarlierDatabase(join(d, "nondh.db"));
    const s = new Store(join(d, "nondh.db"), { key: "secret" });
    expect(s.db.prepare("SELECT title FROM meetings").get()).toEqual({ title: "Encrypted" });
    s.close();
  });

  it("does nothing when the database already exists or there is nothing to adopt", () => {
    const d = dir();
    chromiumDb(join(d, "other.db"));
    adoptEarlierDatabase(join(d, "nondh.db"));
    expect(existsSync(join(d, "nondh.db"))).toBe(false);
    new Store(join(d, "nondh.db")).close();
    const second = new Store(join(d, "second.db"));
    second.close();
    adoptEarlierDatabase(join(d, "nondh.db"));
    expect(existsSync(join(d, "second.db"))).toBe(true);
  });
});
