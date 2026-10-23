import { describe, expect, it } from "vitest";
import { dropCovered, findSensitive, intoCrop, looksSecret, suggestBlurs, type OcrFrame, type OcrWord } from "@shared/video/sensitive";

let x = 0;
const w = (t: string, y = 100): OcrWord => {
  const word = { t, x, y, w: t.length * 8, h: 14 };
  x += t.length * 8 + 6;
  return word;
};
const line = (...ts: string[]) => {
  x = 50;
  return { words: ts.map((t) => w(t)) };
};
const frame = (time: number, ...lines: Array<{ words: OcrWord[] }>): OcrFrame => ({ time, width: 1000, height: 500, lines });

describe("looksSecret", () => {
  it("recognizes common key formats and masked fields", () => {
    expect(looksSecret("sk-ant-api03-AbCdEf123456")).toBe("API key or token");
    expect(looksSecret("ghp_abcdefghijklmnopqrstuvwxyz123456")).toBe("API key or token");
    expect(looksSecret("AKIAIOSFODNN7EXAMPLE")).toBe("API key or token");
    expect(looksSecret("••••••••")).toBe("masked password");
    expect(looksSecret("a8F3kQ9zL2mX7pR4tV6wY1")).toBe("secret-looking string");
  });
  it("leaves ordinary words, numbers and URLs alone", () => {
    for (const ok of ["password", "Wednesday", "2026", "1234567890123456789", "documentation", "hello-world"]) expect(looksSecret(ok)).toBeNull();
  });
});

describe("findSensitive", () => {
  it("blurs the value after a label, not the label", () => {
    const hits = findSensitive(frame(0, line("Password:", "hunter2")));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toBe("hunter2");
    expect(hits[0]!.reason).toBe('value after "Password"');
  });

  it("handles two-word labels and separate colons", () => {
    const hits = findSensitive(frame(0, line("API", "key", ":", "abc123def")));
    expect(hits.map((h) => [h.text, h.reason])).toEqual([["abc123def", 'value after "API key"']]);
  });

  it("finds Luhn-valid card numbers split into groups, but not random digits", () => {
    expect(findSensitive(frame(0, line("Visa", "4111", "1111", "1111", "1111"))).map((h) => h.reason)).toEqual(["card number"]);
    expect(findSensitive(frame(0, line("Order", "4111", "1111", "1111", "1112")))).toEqual([]);
  });

  it("finds bare tokens anywhere on a line", () => {
    expect(findSensitive(frame(0, line("export", "OPENAI_KEY=", "sk-proj-AbCdEf1234567890"))).map((h) => h.text)).toEqual(["sk-proj-AbCdEf1234567890"]);
  });

  it("returns padded normalized rectangles", () => {
    const [h] = findSensitive(frame(0, line("pwd", "s3cret!")));
    expect(h!.rect.x).toBeGreaterThan(0);
    expect(h!.rect.w).toBeLessThan(1);
    expect(h!.rect.y).toBeLessThan(100 / 500);
    expect(h!.rect.y + h!.rect.h).toBeGreaterThan(114 / 500);
  });
});

describe("suggestBlurs", () => {
  it("merges the same spot across consecutive frames into one timed box", () => {
    const frames = [0, 1, 2, 3].map((t) => frame(t, line("Password:", "hunter2")));
    frames.push(frame(9, line("Password:", "hunter2"))); // reappears much later → new box
    const blurs = suggestBlurs(frames, 1);
    expect(blurs.map((b) => [b.start, b.end])).toEqual([
      [0, 4],
      [8, 10],
    ]);
    expect(blurs[0]!.suggested?.text).toBe("hunter2");
  });

  it("returns nothing for frames without secrets", () => {
    expect(suggestBlurs([frame(0, line("Quarterly", "review", "agenda"))], 1)).toEqual([]);
  });
});

describe("intoCrop", () => {
  it("re-expresses boxes in the cropped frame and drops boxes outside it", () => {
    const crop = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
    const r = intoCrop({ x: 0.6, y: 0.6, w: 0.1, h: 0.1 }, crop)!;
    for (const v of [r.x, r.y, r.w, r.h]) expect(v).toBeCloseTo(0.2);
    expect(intoCrop({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, crop)).toBeNull();
    expect(intoCrop({ x: 0.4, y: 0.6, w: 0.2, h: 0.1 }, crop)!.x).toBe(0); // partly outside → clipped
  });
});

describe("dropCovered", () => {
  it("skips suggestions already blurred, keeps new ones", () => {
    const rect = { x: 0.1, y: 0.1, w: 0.2, h: 0.05 };
    const blurred = { id: "a", rect, start: 0, end: 10, strength: 20 };
    const again = { id: "b", rect: { ...rect, x: 0.11 }, start: 1, end: 9, strength: 24, suggested: { reason: "r", text: "t" } };
    const elsewhere = { ...again, id: "c", rect: { ...rect, y: 0.6 } };
    const later = { ...again, id: "d", start: 12, end: 15 };
    expect(dropCovered([again, elsewhere, later], [blurred]).map((b) => b.id)).toEqual(["c", "d"]);
  });
});
