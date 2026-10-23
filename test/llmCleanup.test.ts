import { describe, expect, it } from "vitest";
import { buildCleanupMessages, acceptCleanupOutput } from "@shared/cleanup/llmCleanup";

describe("buildCleanupMessages", () => {
  it("wraps the transcript and lists dictionary terms", () => {
    const msgs = buildCleanupMessages("hello there", { terms: ["Priya", "Kubernetes"] });
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("Priya");
    expect(msgs.at(-1)!.content).toContain("<transcript>\nhello there\n</transcript>");
  });

  it("adds a translation instruction when a target language is set", () => {
    const msgs = buildCleanupMessages("hello", { terms: [], translateTo: "Spanish" });
    expect(msgs[0]!.content).toMatch(/Spanish/);
  });
});

describe("acceptCleanupOutput", () => {
  const input = "so I think we should move the meeting to Wednesday and invite Priya";

  it("accepts a close cleanup and strips tags and think blocks", () => {
    const out = "<think>hmm</think><transcript>So I think we should move the meeting to Wednesday and invite Priya.</transcript>";
    expect(acceptCleanupOutput(input, out)).toBe("So I think we should move the meeting to Wednesday and invite Priya.");
  });

  it("rejects chatty preambles", () => {
    expect(acceptCleanupOutput(input, "Sure! Here is the cleaned text: So I think...")).toBeNull();
  });

  it("rejects an answer instead of a cleanup", () => {
    const q = "what is the capital of France";
    expect(acceptCleanupOutput(q, "The capital of France is Paris.")).toBeNull();
  });

  it("rejects outputs that grow far beyond the input", () => {
    expect(acceptCleanupOutput("hi there", "Hi there. ".repeat(20))).toBeNull();
  });

  it("rejects empty output", () => {
    expect(acceptCleanupOutput(input, "   ")).toBeNull();
  });

  it("accepts list formatting that adds numbers", () => {
    const i = "groceries first eggs second milk third bread";
    expect(acceptCleanupOutput(i, "Groceries:\n1. Eggs\n2. Milk\n3. Bread")).toBe("Groceries:\n1. Eggs\n2. Milk\n3. Bread");
  });

  it("skips the novelty check for translations", () => {
    expect(acceptCleanupOutput("good morning everyone", "Buenos días a todos.", { translated: true })).toBe(
      "Buenos días a todos.",
    );
  });
});
