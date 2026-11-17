import type { MeetingKind } from "../types";
import { removeEchoWords } from "./echo";
import { identify, linesFromSegments, mergeLines, type KnownVoice, type MatchPolicy } from "./speakers";
import { longestOverlapMs } from "./refine";
import type { Segment, SpeakerLabel, TranscriptLine, Turn } from "./types";

export interface ClusterInput {
  cluster: number;
  embedding: number[] | null;
  firstStart: number;
  /** Clear speech behind the embedding (ms); clusters without it are never named by voice. */
  cleanMs?: number;
  /** How consistent the cluster's voice is (0..1); low means mixed or noisy. */
  cohesion?: number;
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
  /** Recognition thresholds for the embedding model that made `clusters` and `voices`. */
  policy: MatchPolicy;
}

export type AssembledSpeaker = SpeakerLabel & { embedding: number[] | null; margin?: number | null; cleanMs?: number; cohesion?: number };

export interface AssembleOutput {
  lines: TranscriptLine[];
  speakers: AssembledSpeaker[];
  echoWordsRemoved: number;
}

/**
 * One stretch of simultaneous speech this long proves two clusters are different people (ms).
 * Shorter overlaps happen between fragments of one voice (see DIARIZATION.refine.cannotLinkMs).
 */
const CANNOT_LINK_MS = 5000;

function talkedTogether(turns: Turn[]): (a: number, b: number) => boolean {
  return (a, b) => longestOverlapMs(turns.filter((t) => t.cluster === a), turns.filter((t) => t.cluster === b)) >= CANNOT_LINK_MS;
}

export function assembleTranscript(i: AssembleInput): AssembleOutput {
  const me = i.voices.find((v) => v.isMe);
  const clusters = i.clusters.map((c) => ({ ...c, cleanMs: c.cleanMs ?? 0 }));
  const cannotLink = talkedTogether(i.turns);

  if (i.kind === "call") {
    // The channel decides "me": everything on the mic (after echo removal) is the user.
    const echo = removeEchoWords(i.primary, i.system ?? []);
    const { labels } = identify(clusters, i.voices.filter((v) => !v.isMe), i.policy, cannotLink);
    const meLabel: AssembledSpeaker = { key: "me", name: "Me", personId: me?.personId ?? null, score: null, confidence: "high", embedding: null };
    const sysLines = linesFromSegments(i.system ?? [], { turns: i.turns, keyFor: (c) => labels.get(c)?.key ?? `c${c}` });
    // No diarization (one voice, or speaker models missing): one "Others" speaker.
    const fallback = !i.turns.length;
    if (fallback) for (const l of sysLines) l.speakerKey = "others";
    const lines = mergeLines(linesFromSegments(echo.segments, { fixedKey: "me" }), sysLines);
    const speakers = [
      meLabel,
      ...(fallback ? [{ key: "others", name: "Others", personId: null, score: null, confidence: "low" as const, embedding: null }] : speakersOf(clusters, labels)),
    ];
    return { lines, speakers: finishSpeakers(speakers, lines), echoWordsRemoved: echo.removedWords };
  }

  // Room or imported file: one mixed track; diarization separates everyone, and the enrolled
  // voice (if any) is matched like anyone else's to find the user.
  const { labels } = identify(clusters, i.voices, i.policy, cannotLink);
  const isMe = (c: number) => !!me && labels.get(c)?.personId === me.personId;
  const keyFor = (c: number) => (isMe(c) ? "me" : labels.get(c)?.key ?? `c${c}`);
  let lines = linesFromSegments(i.primary, { turns: i.turns, keyFor });
  if (!i.turns.length) for (const l of lines) l.speakerKey = "c0";
  lines = mergeLines(lines);
  const speakers = speakersOf(clusters, labels).map((s) => (me && s.personId === me.personId ? { ...s, key: "me", name: "Me" } : s));
  if (!i.turns.length) speakers.push({ key: "c0", name: "Speaker 1", personId: null, score: null, confidence: "low", embedding: null });
  return { lines, speakers: finishSpeakers(speakers, lines), echoWordsRemoved: 0 };
}

/** One speaker per label; fragments merged into another cluster share its label and entry. */
function speakersOf(clusters: Array<Required<Pick<ClusterInput, "cleanMs">> & ClusterInput>, labels: ReturnType<typeof identify>["labels"]): AssembledSpeaker[] {
  const out: AssembledSpeaker[] = [];
  for (const c of clusters) {
    const l = labels.get(c.cluster);
    if (!l || l.key !== `c${c.cluster}`) continue;
    out.push({ ...l, embedding: c.embedding, cleanMs: c.cleanMs, cohesion: c.cohesion });
  }
  return out;
}

/**
 * Keep the speakers who have lines, me first and then in the order they first speak, and number
 * the unnamed ones in that order ("Speaker 1", "Speaker 2"…), so numbers have no gaps.
 */
function finishSpeakers<T extends SpeakerLabel>(speakers: T[], lines: TranscriptLine[]): T[] {
  const first = new Map<string, number>();
  for (const l of lines) if (!(first.get(l.speakerKey)! <= l.start)) first.set(l.speakerKey, l.start);
  const kept = speakers.filter((s) => first.has(s.key)).sort((a, b) => Number(b.key === "me") - Number(a.key === "me") || first.get(a.key)! - first.get(b.key)!);
  let n = 1;
  for (const s of kept) if (!s.personId && /^Speaker( \d+)?$/.test(s.name)) s.name = `Speaker ${n++}`;
  return kept;
}
