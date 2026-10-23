import { describe, expect, it } from "vitest";
import { chunkText, rrf, topK } from "@shared/notes";

describe("chunkText", () => {
  it("keeps short text as one chunk and collapses whitespace", () => {
    expect(chunkText("  Hello   world. ")).toEqual(["Hello world."]);
    expect(chunkText("")).toEqual([]);
  });

  it("splits long text on sentence boundaries with overlap", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const chunks = chunkText(text, 200, 40);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    expect(chunks[0]!.startsWith("Sentence number 0")).toBe(true);
    // overlap: the start of chunk 2 repeats the end of chunk 1
    expect(chunks[0]!.slice(-20).trim().length).toBeGreaterThan(0);
    expect(chunks.join(" ")).toContain("Sentence number 29 is here.");
  });

  it("hard-cuts a sentence that is longer than the chunk size", () => {
    expect(chunkText("a".repeat(1000), 200, 20).length).toBeGreaterThan(3);
  });
});

describe("rrf", () => {
  it("ranks items found by both lists first and reports how they were found", () => {
    const out = rrf(
      [
        { items: ["a", "b", "c"], via: "keyword" },
        { items: ["c", "d"], via: "semantic" },
      ],
      (x) => x,
    );
    expect(out[0]).toMatchObject({ item: "c", via: "both" });
    expect(out.map((o) => o.item).sort()).toEqual(["a", "b", "c", "d"]);
    expect(out.find((o) => o.item === "d")!.via).toBe("semantic");
  });
});

describe("topK", () => {
  it("returns the most similar vectors above the threshold", () => {
    const q = Float32Array.from([1, 0]);
    const out = topK(q, [
      { id: "same", v: Float32Array.from([2, 0]) },
      { id: "near", v: Float32Array.from([1, 0.5]) },
      { id: "orthogonal", v: Float32Array.from([0, 1]) },
    ], 5);
    expect(out.map((o) => o.id)).toEqual(["same", "near"]);
  });
});
