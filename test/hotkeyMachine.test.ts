import { describe, expect, it } from "vitest";
import { HotkeyMachine, type HotkeyAction } from "@shared/hotkeyMachine";

const opts = { holdMs: 300, doubleTapMs: 400 };

function run(steps: Array<[string, number, string?]>) {
  const m = new HotkeyMachine(opts);
  const out: HotkeyAction[] = [];
  for (const [type, t, chord] of steps) {
    if (type === "down") out.push(...m.down((chord ?? "dictate") as never, t));
    else if (type === "up") out.push(...m.up(t));
    else if (type === "cancel") out.push(...m.cancel(t));
    else if (type === "escape") out.push(...m.escape(t));
    else if (type === "tick") out.push(...m.tick(t));
  }
  return { m, out };
}

describe("HotkeyMachine", () => {
  it("push-to-talk: long hold starts then stops", () => {
    const { out, m } = run([
      ["down", 0],
      ["up", 1500],
    ]);
    expect(out).toEqual([{ type: "start", mode: "dictate" }, { type: "stop" }]);
    expect(m.state).toBe("idle");
  });

  it("single short tap with no second tap aborts after the window", () => {
    const { out } = run([
      ["down", 0],
      ["up", 100],
      ["tick", 300],
      ["tick", 501],
    ]);
    expect(out).toEqual([{ type: "start", mode: "dictate" }, { type: "abort" }]);
  });

  it("double tap locks recording, next tap stops", () => {
    const { out, m } = run([
      ["down", 0],
      ["up", 100],
      ["down", 250],
      ["up", 320],
      ["tick", 2000],
      ["down", 5000],
      ["up", 5080],
    ]);
    expect(out).toEqual([{ type: "start", mode: "dictate" }, { type: "lock" }, { type: "stop" }]);
    expect(m.state).toBe("idle");
  });

  it("upgrades dictate to translate when the longer chord appears", () => {
    const { out } = run([
      ["down", 0, "dictate"],
      ["down", 120, "translate"],
      ["up", 1500],
    ]);
    expect(out).toEqual([
      { type: "start", mode: "dictate" },
      { type: "setMode", mode: "translate" },
      { type: "stop" },
    ]);
  });

  it("an upgraded chord never counts as a tap, even if released quickly", () => {
    const { out } = run([
      ["down", 0, "dictate"],
      ["down", 50, "assistant"],
      ["up", 200],
    ]);
    expect(out).toEqual([
      { type: "start", mode: "dictate" },
      { type: "setMode", mode: "assistant" },
      { type: "stop" },
    ]);
  });

  it("cancel (chord used for another shortcut) aborts while pressing", () => {
    const { out, m } = run([
      ["down", 0],
      ["cancel", 100],
      ["up", 150],
    ]);
    expect(out).toEqual([{ type: "start", mode: "dictate" }, { type: "abort" }]);
    expect(m.state).toBe("idle");
  });

  it("escape aborts from any active state and is ignored when idle", () => {
    expect(run([["escape", 0]]).out).toEqual([]);
    const { out } = run([
      ["down", 0],
      ["up", 100],
      ["down", 200],
      ["up", 250],
      ["escape", 3000],
    ]);
    expect(out.at(-1)).toEqual({ type: "abort" });
  });

  it("ignores stray up events when idle", () => {
    expect(run([["up", 10]]).out).toEqual([]);
  });
});
