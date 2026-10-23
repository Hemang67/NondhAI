import { describe, expect, it, vi } from "vitest";
import { needsLlm, runCleanup } from "@shared/cleanup/pipeline";

describe("needsLlm", () => {
  it("skips the LLM for text the rules fully handle", () => {
    expect(needsLlm("Send the report to Priya by Friday.")).toBe(false);
  });
  it("asks for the LLM on lists, unfenced 'like', and unresolved corrections", () => {
    expect(needsLlm("First eggs second milk")).toBe(true);
    expect(needsLlm("It was like really big")).toBe(true);
    expect(needsLlm("Send it to John, I mean Sarah")).toBe(true);
    expect(needsLlm("I went to the the store")).toBe(true);
  });
});

describe("runCleanup", () => {
  const dict = [{ term: "Priya", kind: "name" as const }];

  it("auto mode returns rule output without calling the LLM when not needed", async () => {
    const llm = vi.fn();
    const r = await runCleanup({ raw: "um send it to priya", dictionary: dict, mode: "auto" }, llm);
    expect(r).toEqual({ text: "Send it to Priya", usedLlm: false, llmRejected: false });
    expect(llm).not.toHaveBeenCalled();
  });

  it("uses an accepted LLM result and re-applies dictionary spelling", async () => {
    const llm = vi.fn().mockResolvedValue("Send it to priya, not John.");
    const r = await runCleanup({ raw: "send it to John I mean priya", dictionary: dict, mode: "auto" }, llm);
    expect(r.usedLlm).toBe(true);
    expect(r.text).toBe("Send it to Priya, not John.");
  });

  it("falls back to rules when the guard rejects the LLM output", async () => {
    const llm = vi.fn().mockResolvedValue("Sure! Here's your text.");
    const r = await runCleanup({ raw: "it was like big", dictionary: [], mode: "always" }, llm);
    expect(r).toMatchObject({ text: "It was like big", usedLlm: true, llmRejected: true });
  });

  it("falls back to rules when the LLM errors", async () => {
    const llm = vi.fn().mockRejectedValue(new Error("offline"));
    const r = await runCleanup({ raw: "it was like big", dictionary: [], mode: "always" }, llm);
    expect(r).toMatchObject({ text: "It was like big", llmError: "offline" });
  });

  it("never mode does not call the LLM even with cues", async () => {
    const llm = vi.fn();
    await runCleanup({ raw: "first a second b", dictionary: [], mode: "never" }, llm);
    expect(llm).not.toHaveBeenCalled();
  });

  it("translation always calls the LLM and skips novelty checks", async () => {
    const llm = vi.fn().mockResolvedValue("Buenos días.");
    const r = await runCleanup({ raw: "good morning", dictionary: [], mode: "never", translateTo: "Spanish" }, llm);
    // "never" governs cleanup only; translation was explicitly requested by the hotkey.
    expect(r.text).toBe("Buenos días.");
  });

  it("returns empty for filler-only speech without calling the LLM", async () => {
    const llm = vi.fn();
    expect((await runCleanup({ raw: "um uh", dictionary: [], mode: "always" }, llm)).text).toBe("");
    expect(llm).not.toHaveBeenCalled();
  });
});
