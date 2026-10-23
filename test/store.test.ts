import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, toFtsQuery } from "../src/main/storage/store";

const dirs: string[] = [];
function freshStore(key?: string) {
  const dir = mkdtempSync(join(tmpdir(), "vd-store-"));
  dirs.push(dir);
  return { store: new Store(join(dir, "test.db"), { key }), file: join(dir, "test.db") };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const base = {
  mode: "dictate" as const,
  engine: "parakeet",
  model: "m",
  durationMs: 1000,
  latencyMs: 500,
  cloudUsed: false,
};

describe("Store", () => {
  it("adds, lists newest first, and searches dictations with prefix match", () => {
    const { store } = freshStore();
    store.addDictation({ ...base, rawText: "um the pricing meeting", cleanText: "The pricing meeting" });
    store.addDictation({ ...base, rawText: "email priya", cleanText: "Email Priya" });
    expect(store.listDictations().map((d) => d.cleanText)).toEqual(["Email Priya", "The pricing meeting"]);
    expect(store.listDictations({ query: "pric" }).map((d) => d.cleanText)).toEqual(["The pricing meeting"]);
    expect(store.listDictations({ query: 'pri"ya' })).toHaveLength(1);
    store.close();
  });

  it("soft-deletes and hides deleted dictations from list and search", () => {
    const { store } = freshStore();
    const d = store.addDictation({ ...base, rawText: "secret plan", cleanText: "Secret plan" });
    store.deleteDictation(d.id);
    expect(store.listDictations()).toHaveLength(0);
    expect(store.listDictations({ query: "secret" })).toHaveLength(0);
    expect(store.getDictation(d.id)).toBeNull();
    store.purgeDeleted();
    expect(store.db.prepare("SELECT count(*) c FROM dictations").get()).toEqual({ c: 0 });
    store.close();
  });

  it("upserts and deletes dictionary entries", () => {
    const { store } = freshStore();
    const e = store.upsertDictionary({ term: "Priya", kind: "name", match: null, replacement: null });
    store.upsertDictionary({ ...e, term: "Priyanka" });
    expect(store.listDictionary().map((r) => r.term)).toEqual(["Priyanka"]);
    store.deleteDictionary(e.id);
    expect(store.listDictionary()).toHaveLength(0);
    store.close();
  });

  it("re-opens an existing database without re-running migrations", () => {
    const { store, file } = freshStore();
    store.addDictation({ ...base, rawText: "a", cleanText: "A" });
    store.close();
    const again = new Store(file);
    expect(again.listDictations()).toHaveLength(1);
    again.close();
  });

  it("encrypted databases cannot be opened without the key", () => {
    const { store, file } = freshStore("s3cret");
    store.addDictation({ ...base, rawText: "x", cleanText: "X" });
    store.close();
    expect(() => new Store(file)).toThrow();
    const ok = new Store(file, { key: "s3cret" });
    expect(ok.listDictations()).toHaveLength(1);
    ok.close();
  });

  it("builds quoted FTS queries", () => {
    expect(toFtsQuery('foo "bar" baz')).toBe('"foo" "bar" "baz"*');
  });
});
