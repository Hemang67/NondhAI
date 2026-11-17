import { describe, expect, it } from "vitest";
import { describeVoice, piecesForSpeaker, planPieces, recluster, type EmbeddedPiece, type RawTurn } from "@shared/meeting/refine";

const turn = (cluster: number, start: number, end: number): RawTurn => ({ cluster, start, end });

/** Pieces for a turn, all with the same voice vector (plus a little per-piece variation). */
function voice(v: number[], cluster: number, start: number, end: number, step = 3000): EmbeddedPiece[] {
  const out: EmbeddedPiece[] = [];
  for (let s = start, k = 0; s + 1000 <= end; s += step, k++) {
    out.push({ cluster, start: s, end: Math.min(end, s + step), weak: false, embedding: v.map((x, i) => x + (i === (k % v.length) ? 0.05 : 0)) });
  }
  return out;
}

const A = [1, 0, 0];
const B = [0, 1, 0];
const C = [0, 0, 1];

describe("planPieces", () => {
  it("cuts clean speech into 1–6 s pieces, trimming turn edges", () => {
    const pieces = planPieces([turn(0, 0, 14000)]);
    expect(pieces.every((p) => p.end - p.start >= 1000 && p.end - p.start <= 6000)).toBe(true);
    expect(pieces[0]!.start).toBe(100);
    expect(pieces.at(-1)!.end).toBe(13900);
    expect(pieces.every((p) => !p.weak && p.cluster === 0)).toBe(true);
  });

  it("leaves out stretches where another cluster talks at the same time", () => {
    const pieces = planPieces([turn(0, 0, 10000), turn(1, 4000, 6000)]);
    const own = pieces.filter((p) => p.cluster === 0);
    expect(own.some((p) => p.start < 6000 && p.end > 4000)).toBe(false);
  });

  it("caps the speech embedded per cluster, spread over the meeting", () => {
    const turns = Array.from({ length: 40 }, (_, i) => turn(0, i * 20000, i * 20000 + 10000));
    const pieces = planPieces(turns, { capMsPerCluster: 30000 });
    expect(pieces.reduce((n, p) => n + p.end - p.start, 0)).toBeLessThanOrEqual(30000);
    expect(pieces[0]!.start).toBeLessThan(100000);
    expect(pieces.at(-1)!.start).toBeGreaterThan(600000);
  });

  it("gives a cluster with only short turns one weak piece from its longest turn", () => {
    const pieces = planPieces([turn(0, 0, 10000), turn(1, 12000, 12600), turn(1, 20000, 20400)]);
    expect(pieces.filter((p) => p.cluster === 1)).toEqual([{ cluster: 1, start: 12000, end: 12600, weak: true }]);
  });
});

describe("describeVoice", () => {
  it("averages pieces into one normalised voice with its clear speech and consistency", () => {
    const d = describeVoice(voice(A, 0, 0, 9000))!;
    expect(d.cleanMs).toBe(9000);
    expect(Math.hypot(...d.embedding)).toBeCloseTo(1);
    expect(d.embedding[0]).toBeGreaterThan(0.99);
    expect(d.cohesion).toBeGreaterThan(0.99);
  });

  it("has nothing to describe without pieces", () => {
    expect(describeVoice([])).toBeNull();
  });
});

describe("piecesForSpeaker", () => {
  it("plans clean pieces from one speaker's transcript lines, avoiding other speakers' lines", () => {
    const lines = [
      { start: 0, end: 8000, speakerKey: "c1" },
      { start: 5000, end: 6000, speakerKey: "c2" },
      { start: 9000, end: 9500, speakerKey: "c1" },
    ];
    const pieces = piecesForSpeaker(lines, "c1");
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.every((p) => p.end <= 8000 && !(p.start < 6100 && p.end > 4900))).toBe(true);
  });
});

describe("recluster", () => {
  it("merges fragments of one voice and keeps different voices apart", () => {
    const turns = [turn(0, 0, 10000), turn(1, 11000, 20000), turn(2, 21000, 30000), turn(3, 31000, 40000)];
    const pieces = [...voice(A, 0, 0, 10000), ...voice(B, 1, 11000, 20000), ...voice(A, 2, 21000, 30000), ...voice(B, 3, 31000, 40000)];
    const r = recluster(turns, pieces, { mergeThreshold: 0.6 });
    expect(r.turns.map((t) => t.cluster)).toEqual([0, 1, 0, 1]);
    expect(r.clusters).toHaveLength(2);
  });

  it("does not merge two voices just because their turns alternate", () => {
    const turns = Array.from({ length: 8 }, (_, i) => turn(i % 2, i * 5000, i * 5000 + 4800));
    const pieces = turns.flatMap((t) => voice(t.cluster === 0 ? A : B, t.cluster, t.start, t.end));
    expect(recluster(turns, pieces, { mergeThreshold: 0.6 }).clusters).toHaveLength(2);
  });

  it("never merges clusters that talk at the same time", () => {
    const turns = [turn(0, 0, 10000), turn(1, 8000, 20000)];
    const pieces = [...voice(A, 0, 0, 8000), ...voice(A, 1, 10000, 20000)];
    expect(recluster(turns, pieces, { mergeThreshold: 0.6, cannotLinkMs: 1000 }).clusters).toHaveLength(2);
  });

  it("still merges fragments of one voice that overlap only in short slivers at their boundaries", () => {
    // Three fragments of voice A; the middle one touches each neighbour with a 700 ms boundary
    // overlap (a segmentation artifact). The outer two are the most alike, so they merge first,
    // and their slivers together (1.4 s) must not count as the two voices talking at once.
    const turns = [turn(0, 0, 10700), turn(1, 10000, 20700), turn(2, 20000, 30000), turn(3, 31000, 40000)];
    const same = (cluster: number, start: number, end: number, e: number[]): EmbeddedPiece => ({ cluster, start, end, weak: false, embedding: e });
    const pieces = [
      same(0, 0, 5000, [1, 0, 0]),
      same(0, 5000, 9900, [1, 0, 0]),
      same(1, 10800, 15000, [0.9, 0.3, 0]),
      same(1, 15000, 19900, [0.9, 0.3, 0]),
      same(2, 20800, 25000, [1, 0, 0]),
      same(2, 25000, 30000, [1, 0, 0]),
      ...voice(B, 3, 31000, 40000),
    ];
    const r = recluster(turns, pieces, { mergeThreshold: 0.6, cannotLinkMs: 1000 });
    expect(r.clusters).toHaveLength(2);
    expect(r.turns.map((t) => t.cluster)).toEqual([0, 0, 0, 1]);
  });

  it("folds a small cluster into the closest large one instead of making a new speaker", () => {
    const turns = [turn(0, 0, 10000), turn(1, 11000, 20000), turn(2, 21000, 21600)];
    const pieces: EmbeddedPiece[] = [
      ...voice(A, 0, 0, 10000),
      ...voice(B, 1, 11000, 20000),
      { cluster: 2, start: 21000, end: 21600, weak: true, embedding: [0.1, 0.95, 0] },
    ];
    const r = recluster(turns, pieces, { mergeThreshold: 0.6, minClusterMs: 4000 });
    expect(r.clusters).toHaveLength(2);
    expect(r.turns[2]).toMatchObject({ cluster: 1, uncertain: true });
    expect(r.turns[0]!.uncertain).toBeFalsy();
  });

  it("folds a small cluster with clear speech without flagging it", () => {
    const turns = [turn(0, 0, 10000), turn(1, 11000, 20000), turn(2, 21000, 23000)];
    const pieces = [...voice(A, 0, 0, 10000), ...voice(B, 1, 11000, 20000), { cluster: 2, start: 21100, end: 22900, weak: false, embedding: [0.98, 0.05, 0] }];
    const r = recluster(turns, pieces, { mergeThreshold: 0.6, minClusterMs: 4000, reassignThreshold: 0.5, reassignMargin: 0.1 });
    expect(r.turns[2]).toMatchObject({ cluster: 0 });
    expect(r.turns[2]!.uncertain).toBeFalsy();
  });

  it("numbers clusters by first appearance and describes each one", () => {
    const turns = [turn(7, 0, 9000), turn(3, 10000, 19000), turn(9, 20000, 29000)];
    const pieces = [...voice(C, 7, 0, 9000), ...voice(A, 3, 10000, 19000), ...voice(B, 9, 20000, 29000)];
    const r = recluster(turns, pieces, { mergeThreshold: 0.6 });
    expect(r.turns.map((t) => t.cluster)).toEqual([0, 1, 2]);
    const c0 = r.clusters.find((c) => c.cluster === 0)!;
    expect(c0.firstStart).toBe(0);
    expect(c0.totalMs).toBe(9000);
    expect(c0.cleanMs).toBeGreaterThan(5000);
    expect(c0.cohesion).toBeGreaterThan(0.9);
    expect(c0.embedding![2]).toBeGreaterThan(0.9);
  });

  it("keeps sherpa's clusters when nothing could be embedded", () => {
    const turns = [turn(4, 0, 900), turn(2, 1000, 1800)];
    expect(recluster(turns, [], {}).turns.map((t) => t.cluster)).toEqual([0, 1]);
  });
});
