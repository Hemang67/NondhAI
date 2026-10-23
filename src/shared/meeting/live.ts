import { removeEchoWords } from "./echo";
import { linesFromSegments } from "./speakers";
import type { MeetingKind } from "../types";
import type { Segment, TranscriptLine } from "./types";

/**
 * Live view during a meeting. System-track lines show immediately as "Others" (diarization only
 * runs after the call). Mic lines are held back briefly so the words the other side said can
 * arrive first; any mic words that merely echo them are dropped before the line is shown.
 */
export class LiveTranscript {
  private readonly system: Segment[] = [];
  private readonly held: Array<{ seg: Segment; due: number }> = [];

  constructor(
    private readonly kind: MeetingKind,
    private readonly holdMs = 2500,
  ) {}

  addSystem(seg: Segment): TranscriptLine[] {
    this.system.push(seg);
    // Only recent system speech can be echoed in the mic.
    while (this.system.length && this.system[0]!.end < seg.start - 60000) this.system.shift();
    return linesFromSegments([seg], { fixedKey: "others" });
  }

  addMic(seg: Segment, now: number): void {
    this.held.push({ seg, due: now + this.holdMs });
  }

  /** Release mic lines whose hold has expired (all of them when `force`). */
  release(now: number, force = false): TranscriptLine[] {
    const ready = this.held.filter((h) => force || h.due <= now);
    if (!ready.length) return [];
    this.held.splice(0, this.held.length, ...this.held.filter((h) => !ready.includes(h)));
    const segs = ready.map((r) => r.seg);
    const kept = this.kind === "call" ? removeEchoWords(segs, this.system).segments : segs;
    return linesFromSegments(kept, { fixedKey: this.kind === "call" ? "me" : "room" });
  }
}
