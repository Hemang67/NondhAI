export type Channel = "mic" | "system" | "mixed";

export interface Word {
  w: string;
  start: number; // ms from meeting start
  end: number;
}

/** A recognized stretch of speech on one channel. */
export interface Segment {
  id: string;
  channel: Channel;
  start: number; // ms
  end: number;
  text: string;
  words: Word[];
  /** 0..1 recognizer confidence (mean token probability). */
  conf: number;
}

/** A diarization turn: who spoke when, on one channel. */
export interface Turn {
  start: number;
  end: number;
  cluster: number;
}

export type ConfidenceLevel = "high" | "medium" | "low";

export interface SpeakerLabel {
  /** Stable key within one meeting: "me", "c0", "c1"... */
  key: string;
  /** Display name: "Me", "Speaker 1", or a matched person's name. */
  name: string;
  /** Known person this label was matched to, if any. */
  personId: string | null;
  /** Cosine similarity of the voice match (0..1), null when not matched by voice. */
  score: number | null;
  confidence: ConfidenceLevel;
}

export interface TranscriptLine {
  id: string;
  start: number;
  end: number;
  speakerKey: string;
  channel: Channel;
  text: string;
  conf: number;
  /** Another speaker was talking at the same time. */
  overlap: boolean;
  /** Speaker assignment was a guess (little diarization overlap, or competing turns). */
  uncertainSpeaker: boolean;
}

/** One subject discussed in the meeting, broken into sub-headings with short points. */
export interface SummaryTopic {
  heading: string;
  sections: Array<{ heading: string; points: string[] }>;
}

export interface MeetingSummary {
  /** A short name for the meeting, from what was discussed. */
  title?: string;
  /** Detailed notes grouped by topic; absent on summaries made before topics existed. */
  topics?: SummaryTopic[];
  keyPoints: string[];
  decisions: string[];
  actionItems: Array<{ task: string; owner: string | null; due: string | null }>;
  openQuestions: string[];
}
