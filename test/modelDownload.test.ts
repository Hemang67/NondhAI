import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/main/log", () => ({ log: { info() {}, warn() {}, error() {} } }));

import { ModelManager } from "../src/main/models/modelManager";
import { modelDef, modelPath } from "../src/main/models/registry";

const FILE = Buffer.from("silero-vad model bytes");

/** A server that honours Range like GitHub (sendTotal) or Hugging Face (no Content-Range on 416). */
function server(opts: { sendTotal: boolean }) {
  const calls: (string | undefined)[] = [];
  const fetch = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
    const range = init?.headers?.range;
    calls.push(range);
    if (!range) return new Response(FILE, { status: 200, headers: { "content-length": String(FILE.length) } });
    const start = Number(/bytes=(\d+)-/.exec(range)![1]);
    if (start >= FILE.length) {
      return new Response(null, { status: 416, headers: opts.sendTotal ? { "content-range": `bytes */${FILE.length}` } : {} });
    }
    const rest = FILE.subarray(start);
    return new Response(rest, {
      status: 206,
      headers: { "content-length": String(rest.length), "content-range": `bytes ${start}-${FILE.length - 1}/${FILE.length}` },
    });
  });
  return { fetch, calls };
}

describe("ModelManager.download resume", () => {
  let dir: string;
  const m = modelDef("silero-vad")!;
  const target = () => modelPath(dir, m);
  const part = () => `${target()}.part`;
  const writePart = (b: Buffer) => {
    mkdirSync(dirname(part()), { recursive: true });
    writeFileSync(part(), b);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nondh-models-"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resumes a partial .part with a Range request", async () => {
    const s = server({ sendTotal: true });
    vi.stubGlobal("fetch", s.fetch);
    writePart(FILE.subarray(0, 5));
    await new ModelManager(() => dir).download("silero-vad");
    expect(readFileSync(target())).toEqual(FILE);
    expect(s.calls).toEqual(["bytes=5-"]);
  });

  it("uses a .part that is already complete instead of failing with HTTP 416", async () => {
    const s = server({ sendTotal: true });
    vi.stubGlobal("fetch", s.fetch);
    writePart(FILE);
    await new ModelManager(() => dir).download("silero-vad");
    expect(readFileSync(target())).toEqual(FILE);
    expect(existsSync(part())).toBe(false);
    expect(s.calls).toEqual([`bytes=${FILE.length}-`]);
  });

  it("starts over when the .part is longer than the file on the server", async () => {
    const s = server({ sendTotal: true });
    vi.stubGlobal("fetch", s.fetch);
    writePart(Buffer.concat([FILE, Buffer.from("junk")]));
    await new ModelManager(() => dir).download("silero-vad");
    expect(readFileSync(target())).toEqual(FILE);
    expect(s.calls).toEqual([`bytes=${FILE.length + 4}-`, undefined]);
  });

  it("starts over on HTTP 416 when the server doesn't say the file size", async () => {
    const s = server({ sendTotal: false });
    vi.stubGlobal("fetch", s.fetch);
    writePart(FILE);
    await new ModelManager(() => dir).download("silero-vad");
    expect(readFileSync(target())).toEqual(FILE);
    expect(s.calls).toEqual([`bytes=${FILE.length}-`, undefined]);
  });
});
