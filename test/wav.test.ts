import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav } from "@shared/audio/wav";

describe("wav", () => {
  it("round-trips samples within 16-bit precision", () => {
    const s = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    const { samples, sampleRate } = decodeWav(encodeWav(s, 16000));
    expect(sampleRate).toBe(16000);
    expect(samples.length).toBe(s.length);
    s.forEach((x, i) => expect(Math.abs(samples[i]! - x)).toBeLessThan(1e-4));
  });

  it("clamps out-of-range samples", () => {
    const { samples } = decodeWav(encodeWav(new Float32Array([2, -2]), 8000));
    expect(samples[0]).toBeCloseTo(1, 3);
    expect(samples[1]).toBeCloseTo(-1, 3);
  });

  it("rejects non-WAV data", () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow();
  });
});
