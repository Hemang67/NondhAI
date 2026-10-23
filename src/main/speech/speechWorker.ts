/**
 * Runs in an Electron utilityProcess so model loading and decoding never block the main
 * process. Owns the Parakeet recognizer and the Silero VAD.
 *
 * Dictation flow: begin → audio* → end. While audio arrives, the VAD cuts it at pauses and each
 * finished phrase is decoded right away (PhraseJoiner), so `end` only waits for the tail.
 */
import { PhraseJoiner } from "@shared/speech/phraseJoiner";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sherpa = require("sherpa-onnx-node");

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;

interface Session {
  id: string;
  vad: any;
  joiner: PhraseJoiner;
  leftover: Float32Array;
  samples: number;
  startedAt: number;
}

let recognizer: any = null;
let recognizerKey = "";
let vadModel = "";
let session: Session | null = null;

const port = (process as any).parentPort;
const send = (msg: WorkerResponse) => port.postMessage(msg);

function loadParakeet(dir: string, threads: number): void {
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

async function decodeSamples(samples: Float32Array): Promise<string> {
  const stream = recognizer.createStream();
  // Pad with a little silence: transducers clip the last word without trailing context.
  const padded = new Float32Array(samples.length + SAMPLE_RATE * 0.3);
  padded.set(samples);
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: padded });
  const result = await recognizer.decodeAsync(stream);
  return result.text ?? "";
}

function drainVad(s: Session): void {
  while (!s.vad.isEmpty()) {
    const seg = s.vad.front(false);
    s.vad.pop();
    s.joiner.push(Float32Array.from(seg.samples));
  }
}

function feed(s: Session, chunk: Float32Array): void {
  s.samples += chunk.length;
  let buf = chunk;
  if (s.leftover.length) {
    buf = new Float32Array(s.leftover.length + chunk.length);
    buf.set(s.leftover);
    buf.set(chunk, s.leftover.length);
  }
  let off = 0;
  for (; off + VAD_WINDOW <= buf.length; off += VAD_WINDOW) {
    s.vad.acceptWaveform(buf.subarray(off, off + VAD_WINDOW));
  }
  s.leftover = buf.slice(off);
  drainVad(s);
}

async function handle(msg: WorkerRequest): Promise<void> {
  switch (msg.type) {
    case "init":
      vadModel = msg.vadModel;
      loadParakeet(msg.parakeetDir, msg.threads);
      send({ type: "ready" });
      return;
    case "begin":
      session?.joiner.abort();
      session = {
        id: msg.id,
        vad: makeVad(),
        joiner: new PhraseJoiner(decodeSamples),
        leftover: new Float32Array(0),
        samples: 0,
        startedAt: Date.now(),
      };
      return;
    case "audio":
      if (session?.id === msg.id) feed(session, msg.samples);
      return;
    case "end": {
      const s = session;
      if (!s || s.id !== msg.id) {
        send({ type: "final", id: msg.id, text: "", decodeMs: 0, audioMs: 0 });
        return;
      }
      const t0 = Date.now();
      if (s.leftover.length) {
        const pad = new Float32Array(VAD_WINDOW);
        pad.set(s.leftover);
        s.vad.acceptWaveform(pad);
      }
      s.vad.flush();
      drainVad(s);
      const text = await s.joiner.finish();
      if (session === s) session = null;
      send({ type: "final", id: s.id, text, decodeMs: Date.now() - t0, audioMs: (s.samples / SAMPLE_RATE) * 1000 });
      return;
    }
    case "abort":
      if (session?.id === msg.id) {
        session.joiner.abort();
        session = null;
      }
      return;
    case "transcribe": {
      const t0 = Date.now();
      const text = await decodeWhole(msg.samples);
      send({ type: "final", id: msg.id, text, decodeMs: Date.now() - t0, audioMs: (msg.samples.length / SAMPLE_RATE) * 1000 });
      return;
    }
  }
}

/** Whole-buffer path (imports, re-transcribe): still VAD-split, since Parakeet degrades on very long input. */
async function decodeWhole(samples: Float32Array): Promise<string> {
  const vad = makeVad();
  const joiner = new PhraseJoiner(decodeSamples);
  let off = 0;
  for (; off + VAD_WINDOW <= samples.length; off += VAD_WINDOW) {
    vad.acceptWaveform(samples.subarray(off, off + VAD_WINDOW));
    while (!vad.isEmpty()) {
      joiner.push(Float32Array.from(vad.front(false).samples));
      vad.pop();
    }
  }
  vad.flush();
  while (!vad.isEmpty()) {
    joiner.push(Float32Array.from(vad.front(false).samples));
    vad.pop();
  }
  return joiner.finish();
}

port.on("message", (e: { data: WorkerRequest }) => {
  handle(e.data).catch((err: unknown) => {
    const id = "id" in e.data ? (e.data as { id: string }).id : undefined;
    send({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  });
});
