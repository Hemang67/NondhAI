/**
 * Runs in an Electron utilityProcess so model loading and decoding never block the main
 * process. Owns the Parakeet recognizer, Silero VAD, and (for meetings) the pyannote
 * segmentation + CAM++ speaker-embedding models.
 *
 * Dictation: begin → audio* → end. While audio arrives, the VAD cuts it at pauses and each
 * finished phrase is decoded right away (PhraseJoiner), so `end` only waits for the tail.
 * Meetings: one timestamped stream per channel for the live view, then a final pass over the
 * recorded file plus diarization.
 */
import { readFileSync } from "node:fs";
import { PhraseJoiner } from "@shared/speech/phraseJoiner";
import { confidenceFromLogProbs, tokensToWords } from "@shared/meeting/words";
import type { Channel, Segment, Turn } from "@shared/meeting/types";
import type { ClusterInfo, DiarizationModels, WorkerRequest, WorkerResponse } from "./workerProtocol";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sherpa = require("sherpa-onnx-node");

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;

interface DictationSession {
  id: string;
  vad: any;
  joiner: PhraseJoiner;
  leftover: Float32Array;
  samples: number;
}

interface MeetingStream {
  id: string;
  channel: Channel;
  offsetMs: number;
  vad: any;
  leftover: Float32Array;
  chain: Promise<void>;
  count: number;
}

let recognizer: any = null;
let recognizerKey = "";
let vadModel = "";
let threads = 4;
let diarizationModels: DiarizationModels | null = null;
let embedder: any = null;
let dictation: DictationSession | null = null;
const streams = new Map<string, MeetingStream>();

const port = (process as any).parentPort;
const send = (msg: WorkerResponse) => port.postMessage(msg);

function loadParakeet(dir: string): void {
  const key = `${dir}|${threads}`;
  if (recognizer && recognizerKey === key) return;
  const t0 = Date.now();
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: `${dir}/encoder.int8.onnx`,
        decoder: `${dir}/decoder.int8.onnx`,
        joiner: `${dir}/joiner.int8.onnx`,
      },
      tokens: `${dir}/tokens.txt`,
      numThreads: threads,
      provider: "cpu",
      modelType: "nemo_transducer",
      debug: 0,
    },
  });
  recognizerKey = key;
  // Warm-up: the first decode pays one-time graph setup costs.
  const s = recognizer.createStream();
  s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(SAMPLE_RATE) });
  recognizer.decode(s);
  send({ type: "log", message: `parakeet loaded in ${Date.now() - t0} ms (${threads} threads)` });
}

function makeVad(): any {
  return new sherpa.Vad(
    {
      sileroVad: {
        model: vadModel,
        threshold: 0.5,
        minSilenceDuration: 0.45,
        minSpeechDuration: 0.2,
        maxSpeechDuration: 20,
        windowSize: VAD_WINDOW,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      debug: 0,
    },
    60,
  );
}

async function recognize(samples: Float32Array): Promise<any> {
  const stream = recognizer.createStream();
  // Pad with a little silence: transducers clip the last word without trailing context.
  const padded = new Float32Array(samples.length + SAMPLE_RATE * 0.3);
  padded.set(samples);
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: padded });
  return recognizer.decodeAsync(stream);
}

async function decodeText(samples: Float32Array): Promise<string> {
  return ((await recognize(samples)).text ?? "") as string;
}

let segCounter = 0;
async function decodeSegment(samples: Float32Array, startMs: number, channel: Channel): Promise<Segment | null> {
  const r = await recognize(samples);
  const text = ((r.text ?? "") as string).trim();
  if (!text) return null;
  const endMs = startMs + Math.round((samples.length / SAMPLE_RATE) * 1000);
  const words = tokensToWords(r.tokens ?? [], r.timestamps ?? [], startMs, endMs);
  return {
    id: `${channel[0]}${startMs}-${segCounter++}`,
    channel,
    start: words[0]?.start ?? startMs,
    end: endMs,
    text,
    words,
    conf: confidenceFromLogProbs(r.ys_log_probs),
  };
}

/** Feed samples to a VAD in fixed windows; returns the leftover tail. */
function feedVad(vad: any, leftover: Float32Array, chunk: Float32Array, onSegment: (samples: Float32Array, start: number) => void): Float32Array {
  let buf = chunk;
  if (leftover.length) {
    buf = new Float32Array(leftover.length + chunk.length);
    buf.set(leftover);
    buf.set(chunk, leftover.length);
  }
  let off = 0;
  for (; off + VAD_WINDOW <= buf.length; off += VAD_WINDOW) vad.acceptWaveform(buf.subarray(off, off + VAD_WINDOW));
  drain(vad, onSegment);
  return buf.slice(off);
}

function drain(vad: any, onSegment: (samples: Float32Array, start: number) => void): void {
  while (!vad.isEmpty()) {
    const seg = vad.front(false);
    vad.pop();
    onSegment(Float32Array.from(seg.samples), seg.start as number);
  }
}

function flushVad(vad: any, leftover: Float32Array, onSegment: (samples: Float32Array, start: number) => void): void {
  if (leftover.length) {
    const pad = new Float32Array(VAD_WINDOW);
    pad.set(leftover);
    vad.acceptWaveform(pad);
  }
  vad.flush();
  drain(vad, onSegment);
}

function readPcm16(path: string): Float32Array {
  const buf = readFileSync(path);
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

function ensureEmbedder(): any {
  if (!diarizationModels) throw new Error("speaker models are not installed");
  if (!embedder) {
    embedder = new sherpa.SpeakerEmbeddingExtractor({ model: diarizationModels.embedding, numThreads: threads, debug: 0 });
  }
  return embedder;
}

function embed(samples: Float32Array): number[] {
  const ex = ensureEmbedder();
  const s = ex.createStream();
  s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  s.inputFinished();
  return Array.from(ex.compute(s, false) as Float32Array);
}

function diarize(samples: Float32Array, numSpeakers?: number, threshold?: number): { turns: Turn[]; clusters: ClusterInfo[] } {
  if (!diarizationModels) throw new Error("speaker models are not installed");
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: diarizationModels.segmentation }, numThreads: threads, debug: 0 },
    embedding: { model: diarizationModels.embedding, numThreads: threads, debug: 0 },
    clustering: { numClusters: numSpeakers ?? -1, threshold: threshold ?? 0.6 },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  });
  const raw = sd.process(samples) as Array<{ start: number; end: number; speaker: number }>;
  const turns: Turn[] = raw.map((t) => ({ start: Math.round(t.start * 1000), end: Math.round(t.end * 1000), cluster: t.speaker }));
  // One embedding per cluster: average over its longest turns (up to ~60 s), which is what
  // later meetings are matched against.
  const byCluster = new Map<number, Turn[]>();
  for (const t of turns) {
    if (!byCluster.has(t.cluster)) byCluster.set(t.cluster, []);
    byCluster.get(t.cluster)!.push(t);
  }
  const clusters: ClusterInfo[] = [];
  for (const [cluster, ts] of byCluster) {
    const longest = [...ts].sort((a, b) => b.end - b.start - (a.end - a.start));
    const picked: Float32Array[] = [];
    let total = 0;
    for (const t of longest) {
      if (t.end - t.start < 800 || total > 60000) continue;
      picked.push(samples.subarray(Math.floor((t.start / 1000) * SAMPLE_RATE), Math.floor((t.end / 1000) * SAMPLE_RATE)));
      total += t.end - t.start;
    }
    let embedding: number[] | null = null;
    if (picked.length) {
      const joined = new Float32Array(picked.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of picked) {
        joined.set(p, off);
        off += p.length;
      }
      embedding = embed(joined);
    }
    clusters.push({
      cluster,
      embedding,
      firstStart: Math.min(...ts.map((t) => t.start)),
      totalMs: ts.reduce((n, t) => n + t.end - t.start, 0),
    });
  }
  return { turns, clusters };
}

async function finalPass(id: string, path: string, channel: Channel): Promise<Segment[]> {
  const samples = readPcm16(path);
  const vad = makeVad();
  const pending: Array<{ samples: Float32Array; start: number }> = [];
  const left = feedVad(vad, new Float32Array(0), samples, (s, start) => pending.push({ samples: s, start }));
  flushVad(vad, left, (s, start) => pending.push({ samples: s, start }));
  const out: Segment[] = [];
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i]!;
    const seg = await decodeSegment(p.samples, Math.round((p.start / SAMPLE_RATE) * 1000), channel);
    if (seg) out.push(seg);
    if (i % 5 === 0) send({ type: "progress", id, done: i + 1, total: pending.length });
  }
  return out;
}

async function handle(msg: WorkerRequest): Promise<void> {
  switch (msg.type) {
    case "init":
      vadModel = msg.vadModel;
      threads = msg.threads;
      diarizationModels = msg.diarization ?? null;
      loadParakeet(msg.parakeetDir);
      send({ type: "ready" });
      return;

    // ---- dictation ----
    case "begin":
      dictation?.joiner.abort();
      dictation = { id: msg.id, vad: makeVad(), joiner: new PhraseJoiner(decodeText), leftover: new Float32Array(0), samples: 0 };
      return;
    case "audio": {
      const s = dictation;
      if (s?.id !== msg.id) return;
      s.samples += msg.samples.length;
      s.leftover = feedVad(s.vad, s.leftover, msg.samples, (seg) => s.joiner.push(seg));
      return;
    }
    case "end": {
      const s = dictation;
      if (!s || s.id !== msg.id) {
        send({ type: "final", id: msg.id, text: "", decodeMs: 0, audioMs: 0 });
        return;
      }
      const t0 = Date.now();
      flushVad(s.vad, s.leftover, (seg) => s.joiner.push(seg));
      const text = await s.joiner.finish();
      if (dictation === s) dictation = null;
      send({ type: "final", id: s.id, text, decodeMs: Date.now() - t0, audioMs: (s.samples / SAMPLE_RATE) * 1000 });
      return;
    }
    case "abort":
      if (dictation?.id === msg.id) {
        dictation.joiner.abort();
        dictation = null;
      }
      return;
    case "transcribe": {
      const t0 = Date.now();
      const vad = makeVad();
      const joiner = new PhraseJoiner(decodeText);
      flushVad(vad, feedVad(vad, new Float32Array(0), msg.samples, (s) => joiner.push(s)), (s) => joiner.push(s));
      const text = await joiner.finish();
      send({ type: "final", id: msg.id, text, decodeMs: Date.now() - t0, audioMs: (msg.samples.length / SAMPLE_RATE) * 1000 });
      return;
    }

    // ---- meetings, live ----
    case "stream-begin":
      streams.set(msg.id, {
        id: msg.id,
        channel: msg.channel,
        offsetMs: msg.offsetMs,
        vad: makeVad(),
        leftover: new Float32Array(0),
        chain: Promise.resolve(),
        count: 0,
      });
      return;
    case "stream-audio": {
      const st = streams.get(msg.id);
      if (!st) return;
      st.leftover = feedVad(st.vad, st.leftover, msg.samples, (samples, start) => queueLive(st, samples, start));
      return;
    }
    case "stream-end": {
      const st = streams.get(msg.id);
      if (!st) {
        send({ type: "stream-done", id: msg.id });
        return;
      }
      flushVad(st.vad, st.leftover, (samples, start) => queueLive(st, samples, start));
      await st.chain;
      streams.delete(msg.id);
      send({ type: "stream-done", id: msg.id });
      return;
    }

    // ---- meetings, after the call ----
    case "final-pass": {
      const t0 = Date.now();
      const segments = await finalPass(msg.id, msg.path, msg.channel);
      send({ type: "segments", id: msg.id, segments, ms: Date.now() - t0 });
      return;
    }
    case "diarize": {
      const t0 = Date.now();
      const r = diarize(readPcm16(msg.path), msg.numSpeakers, msg.threshold);
      send({ type: "diarized", id: msg.id, ...r, ms: Date.now() - t0 });
      return;
    }
    case "embed":
      send({ type: "embedding", id: msg.id, embedding: embed(msg.samples) });
      return;
  }
}

function queueLive(st: MeetingStream, samples: Float32Array, start: number): void {
  const startMs = st.offsetMs + Math.round((start / SAMPLE_RATE) * 1000);
  st.chain = st.chain.then(async () => {
    const seg = await decodeSegment(samples, startMs, st.channel);
    if (seg) send({ type: "segment", id: st.id, segment: seg });
  });
}

port.on("message", (e: { data: WorkerRequest }) => {
  handle(e.data).catch((err: unknown) => {
    const id = "id" in e.data ? (e.data as { id: string }).id : undefined;
    send({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  });
});
