/**
 * Turns raw chord down/up events from the native key hook into recording actions.
 *
 * Behaviour (one chord drives both modes):
 *  - Hold the chord ≥ holdMs, release → push-to-talk: stop and transcribe.
 *  - Tap twice within doubleTapMs → toggle: keeps recording until the next tap.
 *  - A single short tap with no follow-up → abort (accidental press).
 * Recording starts on the first key-down so no speech is lost while we decide.
 * A longer chord that extends the held one (Ctrl+Win → Ctrl+Win+T) upgrades the mode.
 */
export type ChordMode = "dictate" | "translate" | "assistant";

export type HotkeyAction =
  | { type: "start"; mode: ChordMode }
  | { type: "setMode"; mode: ChordMode }
  | { type: "lock" }
  | { type: "stop" }
  | { type: "abort" };

type State =
  | { name: "idle" }
  | { name: "pressing"; downAt: number; upgraded: boolean }
  | { name: "awaitingSecondTap"; deadline: number }
  | { name: "secondTapDown" }
  | { name: "locked" }
  | { name: "lockedReleasePending" };

export interface HotkeyMachineOptions {
  holdMs: number;
  doubleTapMs: number;
}

export class HotkeyMachine {
  private s: State = { name: "idle" };
  private mode: ChordMode = "dictate";

  constructor(private readonly opts: HotkeyMachineOptions) {}

  get state(): State["name"] {
    return this.s.name;
  }

  get currentMode(): ChordMode {
    return this.mode;
  }

  down(chord: ChordMode, t: number): HotkeyAction[] {
    switch (this.s.name) {
      case "idle":
        this.mode = chord;
        this.s = { name: "pressing", downAt: t, upgraded: false };
        return [{ type: "start", mode: chord }];
      case "pressing":
        if (chord !== this.mode) {
          this.mode = chord;
          this.s = { ...this.s, upgraded: true };
          return [{ type: "setMode", mode: chord }];
        }
        return [];
      case "awaitingSecondTap":
        this.s = { name: "secondTapDown" };
        return [{ type: "lock" }];
      case "locked":
        this.s = { name: "lockedReleasePending" };
        return [{ type: "stop" }];
      default:
        return [];
    }
  }

  up(t: number): HotkeyAction[] {
    switch (this.s.name) {
      case "pressing": {
        const held = t - this.s.downAt;
        if (held >= this.opts.holdMs || this.s.upgraded) {
          this.s = { name: "idle" };
          return [{ type: "stop" }];
        }
        this.s = { name: "awaitingSecondTap", deadline: t + this.opts.doubleTapMs };
        return [];
      }
      case "secondTapDown":
        this.s = { name: "locked" };
        return [];
      case "lockedReleasePending":
        this.s = { name: "idle" };
        return [];
      default:
        return [];
    }
  }

  /** The held chord turned into some other shortcut (e.g. Ctrl+Win+Left). */
  cancel(_t: number): HotkeyAction[] {
    if (this.s.name === "pressing" || this.s.name === "secondTapDown") {
      this.s = { name: "idle" };
      return [{ type: "abort" }];
    }
    return [];
  }

  escape(_t: number): HotkeyAction[] {
    if (this.s.name === "idle" || this.s.name === "lockedReleasePending") return [];
    this.s = { name: "idle" };
    return [{ type: "abort" }];
  }

  /** Call periodically (or at the deadline) so a lone tap can time out. */
  tick(t: number): HotkeyAction[] {
    if (this.s.name === "awaitingSecondTap" && t >= this.s.deadline) {
      this.s = { name: "idle" };
      return [{ type: "abort" }];
    }
    return [];
  }

  /** The controller finished or failed a recording on its own (e.g. max length). */
  reset(): void {
    this.s = { name: "idle" };
  }
}
