import { describe, expect, it } from "vitest";
import { applyRules, type DictionaryEntry } from "@shared/cleanup/rules";

const clean = (s: string, dict: DictionaryEntry[] = []) => applyRules(s, { dictionary: dict });

describe("cleanup rules", () => {
  it("removes standalone filler words and their commas", () => {
    expect(clean("Um, so I think, uh, we should go.")).toBe("So I think we should go.");
    expect(clean("Hmm I'm not sure erm about that")).toBe("I'm not sure about that");
  });

  it("removes 'like' only when it is set off as a filler", () => {
    expect(clean("It was, like, really big.")).toBe("It was really big.");
    expect(clean("I like this plan.")).toBe("I like this plan.");
  });

  it("does not touch filler-looking substrings inside words", () => {
    expect(clean("The umbrella is in the hummus aisle.")).toBe("The umbrella is in the hummus aisle.");
  });

  it("applies weekday self-corrections", () => {
    expect(clean("Let's meet on Tuesday — no, Wednesday at noon.")).toBe("Let's meet on Wednesday at noon.");
    expect(clean("Let's meet on Tuesday, no wait, Wednesday.")).toBe("Let's meet on Wednesday.");
  });

  it("applies number self-corrections", () => {
    expect(clean("Call me at 3, no wait, 4 pm.")).toBe("Call me at 4 pm.");
  });

  it("applies name self-corrections with 'I mean'", () => {
    expect(clean("Send the deck to John, I mean Sarah, by tomorrow.")).toBe("Send the deck to Sarah by tomorrow.");
  });

  it("does not treat lowercase words around 'I mean' as a correction", () => {
    expect(clean("It's fine, I mean really fine.")).toBe("It's fine, I mean really fine.");
  });

  it("leaves a plain 'no' alone when it is not a correction", () => {
    expect(clean("I said no, thanks.")).toBe("I said no, thanks.");
  });

  it("drops the previous sentence on 'scratch that'", () => {
    expect(clean("Send the report today. Scratch that. Send it tomorrow.")).toBe("Send it tomorrow.");
  });

  it("turns spoken 'new line' and 'new paragraph' into breaks", () => {
    expect(clean("Hi team new paragraph thanks for coming new line Bob")).toBe("Hi team\n\nThanks for coming\nBob");
  });

  it("applies dictionary replacements and canonical casing", () => {
    const dict: DictionaryEntry[] = [
      { term: "Kubernetes", kind: "name" },
      { term: "Nondh AI", replacement: "Nondh AI", match: "nondh ai", kind: "replace" },
    ];
    expect(clean("deploy nondh ai to kubernetes", dict)).toBe("Deploy Nondh AI to Kubernetes");
  });

  it("fixes lone lowercase i and sentence capitalization", () => {
    expect(clean("i think so. then i left")).toBe("I think so. Then I left");
  });

  it("returns empty string for filler-only input", () => {
    expect(clean("Um. Uh.")).toBe("");
  });
});
