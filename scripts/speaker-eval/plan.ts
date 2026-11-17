/**
 * Turn plans for synthetic meetings (speaker-identification evaluation). A plan says who talks
 * when and for how long; render.ts fills it with real speech from single-speaker recordings.
 *
 * Shape of a plan: a round of introductions (everyone once), then main turns from speakers
 * picked with uneven participation (a few people talk most), some long monologues, some
 * interruptions that start before the previous turn ends, and short acknowledgements (0.3–0.8 s)
 * either as a reply after a turn or as a back-channel during it.
 */
export interface PlanSpec {
  seed: number;
  speakers: string[];
  durationMs: number;
  /** Share of all turns that are acknowledgements. */
  ackRate: number;
  /** Share of main turns that are long monologues (30–90 s). */
  longRate: number;
  /** Share of main turns that start before the previous one ends. */
  overlapRate: number;
}

export interface PlannedTurn {
  speaker: string;
  start: number;
  durMs: number;
  kind: "ack" | "normal" | "long";
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function planConversation(s: PlanSpec): PlannedTurn[] {
  const rnd = mulberry32(s.seed);
  const u = (a: number, b: number) => a + (b - a) * rnd();
  const order = [...s.speakers];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  // Uneven participation: the first in the shuffled order talks most.
  const weight = new Map(order.map((sp, i) => [sp, 1 / Math.pow(i + 1, 0.7)]));
  const pick = (exclude?: string) => {
    const pool = order.filter((sp) => sp !== exclude);
    let r = rnd() * pool.reduce((n, sp) => n + weight.get(sp)!, 0);
    for (const sp of pool) if ((r -= weight.get(sp)!) <= 0) return sp;
    return pool[pool.length - 1]!;
  };
  const acksPerMain = s.ackRate > 0 ? s.ackRate / (1 - s.ackRate) : 0;

  const out: PlannedTurn[] = [];
  let t = 0;
  let prev: PlannedTurn | null = null;
  for (let i = 0; t < s.durationMs; i++) {
    const intro = i < order.length;
    const speaker = intro ? order[i]! : pick(prev?.speaker);
    const kind: PlannedTurn["kind"] = !intro && rnd() < s.longRate ? "long" : "normal";
    const durMs = Math.round(kind === "long" ? u(30000, 90000) : u(2500, 12000));
    const start =
      prev && !intro && rnd() < s.overlapRate
        ? Math.round(Math.max(prev.start + 500, prev.start + prev.durMs - u(300, 1500)))
        : Math.round(t + u(150, 900));
    const turn: PlannedTurn = { speaker, start, durMs, kind };
    out.push(turn);
    t = Math.max(t, start + durMs);

    if (!intro && acksPerMain > 0) {
      const n = Math.floor(acksPerMain) + (rnd() < acksPerMain % 1 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const ackDur = Math.round(u(300, 800));
        const by = pick(speaker);
        if (rnd() < 0.5) {
          out.push({ speaker: by, start: Math.round(start + u(0.2, 0.8) * durMs), durMs: ackDur, kind: "ack" });
        } else {
          const at = Math.round(t + u(150, 600));
          out.push({ speaker: by, start: at, durMs: ackDur, kind: "ack" });
          t = at + ackDur;
        }
      }
    }
    prev = turn;
  }
  return out.sort((a, b) => a.start - b.start);
}
