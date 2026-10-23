import type { MeetingKind } from "../types";
import { removeEchoWords } from "./echo";
import { labelClusters, linesFromSegments, matchVoice, mergeLines, type KnownVoice } from "./speakers";
import type { Segment, SpeakerLabel, TranscriptLine, Turn } from "./types";

export interface ClusterInput {
  cluster: number;
  embedding: number[] | null;
  firstStart: number;
}

export interface AssembleInput {
  kind: MeetingKind;
  /** Call: the mic track. Room/import: the only track. */
  primary: Segment[];
  /** Call only: the system (loopback) track. */
  system?: Segment[];
  /** Diarization of the system track (call) or the only track (room/import). */
  turns: Turn[];
  clusters: ClusterInput[];
  voices: Array<KnownVoice & { isMe: boolean }>;
}

export interface AssembleOutput {
  lines: TranscriptLine[];
  speakers: Array<SpeakerLabel & { embedding: number[] | null }>;
  echoWordsRemoved: number;
}

export function assembleTranscript(i: AssembleInput): AssembleOutput {
  const me = i.voices.find((v) => v.isMe);
  if (i.kind === "call") {
    // The channel decides "me": everything on the mic (after echo removal) is the user.
    const echo = removeEchoWords(i.primary, i.system ?? []);
    const others = i.voices.filter((v) => !v.isMe);
    const labels = labelClusters(i.clusters, others);
    const meLabel: SpeakerLabel & { embedding: null } = {
      key: "me",
      name: "Me",
      personId: me?.personId ?? null,
      score: null,
      confidence: "high",
      embedding: null,
    };
    const sysLines = linesFromSegments(i.system ?? [], { turns: i.turns, keyFor: (c) => labels.get(c)?.key ?? `c${c}` });
    // No diarization (one voice, or speaker models missing): one "Others" speaker.
    const fallback = !i.turns.length;
    if (fallback) for (const l of sysLines) l.speakerKey = "others";
    const lines = mergeLines(linesFromSegments(echo.segments, { fixedKey: "me" }), sysLines);
    const speakers = [
      meLabel,
      ...(fallback
        ? [{ key: "others", name: "Others", personId: null, score: null, confidence: "low" as const, embedding: null }]
        : i.clusters.map((c) => ({ ...labels.get(c.cluster)!, embedding: c.embedding }))),
    ];
    return { lines, speakers: speakers.filter((s) => lines.some((l) => l.speakerKey === s.key)), echoWordsRemoved: echo.removedWords };
  }

  // Room or imported file: one mixed track; diarization separates everyone, and the enrolled
  // voice (if any) identifies the user.
  let meCluster: number | null = null;
  let meScore: number | null = null;
  if (me) {
    let best = 0;
    for (const c of i.clusters) {
      if (!c.embedding) continue;
      const m = matchVoice(c.embedding, [me]);
      if (m && m.score > best) {
        best = m.score;
        meCluster = c.cluster;
        meScore = m.score;
      }
    }
  }
  const rest = i.clusters.filter((c) => c.cluster !== meCluster);
  const labels = labelClusters(rest, i.voices.filter((v) => !v.isMe));
  const keyFor = (c: number) => (c === meCluster ? "me" : labels.get(c)?.key ?? `c${c}`);
  let lines = linesFromSegments(i.primary, { turns: i.turns, keyFor });
  if (!i.turns.length) for (const l of lines) l.speakerKey = "c0";
  lines = mergeLines(lines);
  const speakers: Array<SpeakerLabel & { embedding: number[] | null }> = [];
  if (meCluster !== null) {
    const c = i.clusters.find((x) => x.cluster === meCluster)!;
    speakers.push({
      key: "me",
      name: "Me",
      personId: me!.personId,
      score: meScore,
      confidence: meScore !== null && meScore >= 0.7 ? "high" : "medium",
      embedding: c.embedding,
    });
  }
  for (const c of rest) speakers.push({ ...labels.get(c.cluster)!, embedding: c.embedding });
  if (!i.turns.length) speakers.push({ key: "c0", name: "Speaker 1", personId: null, score: null, confidence: "low", embedding: null });
  return { lines, speakers: speakers.filter((s) => lines.some((l) => l.speakerKey === s.key)), echoWordsRemoved: 0 };
}
