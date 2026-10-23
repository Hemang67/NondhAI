import { describe, expect, it } from "vitest";
import { LiveTranscript } from "@shared/meeting/live";
import type { Segment } from "@shared/meeting/types";

function seg(channel: "mic" | "system", text: string, start: number): Segment {
  const words = text.split(" ").map((w, i) => ({ w, start: start + i * 300, end: start + (i + 1) * 300 }));
  return { id: `${channel}${start}`, channel, start, end: words.at(-1)!.end, text, words, conf: 0.9 };
}

describe("LiveTranscript", () => {
  it("shows system lines immediately as others", () => {
    const live = new LiveTranscript("call");
    expect(live.addSystem(seg("system", "hello everyone", 0))[0]).toMatchObject({ speakerKey: "others", text: "hello everyone" });
  });

  it("holds mic lines and drops echoed words once the system words have arrived", () => {
    const live = new LiveTranscript("call", 2500);
    live.addMic(seg("mic", "move it to Wednesday sounds good", 1100), 10_000);
    expect(live.release(11_000)).toEqual([]); // still held
    live.addSystem(seg("system", "let's move it to Wednesday", 800));
    const out = live.release(12_600);
    expect(out.map((l) => [l.speakerKey, l.text])).toEqual([["me", "sounds good"]]);
  });

  it("releases everything on force and labels room mode mic lines as room", () => {
    const live = new LiveTranscript("room");
    live.addMic(seg("mic", "anyone there", 0), 0);
    expect(live.release(0, true)[0]!.speakerKey).toBe("room");
  });
});
