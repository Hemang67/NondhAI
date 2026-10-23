/**
 * Microphone capture for dictation. Runs in the (hidden) pill window. Chromium resamples to
 * 16 kHz for us; an AudioWorklet hands back raw frames which are batched into ~100 ms chunks.
 */
const WORKLET = `
class VdCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("vd-capture", VdCapture);
`;

const CHUNK = 1600; // 100 ms at 16 kHz

export class Recorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private pending: Float32Array[] = [];
  private pendingLen = 0;
  private sessionId: string | null = null;

  constructor(
    private readonly onChunk: (sessionId: string, samples: Float32Array) => void,
    private readonly onLevel: (rms: number) => void,
  ) {}

  async start(sessionId: string): Promise<void> {
    await this.stop();
    this.sessionId = sessionId;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, "vd-capture");
    this.node = node;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.push(e.data);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination);
  }

  private push(frame: Float32Array): void {
    if (!this.sessionId) return;
    this.pending.push(frame);
    this.pendingLen += frame.length;
    if (this.pendingLen >= CHUNK) this.flush();
  }

  private flush(): void {
    if (!this.sessionId || !this.pendingLen) return;
    const out = new Float32Array(this.pendingLen);
    let off = 0;
    for (const f of this.pending) {
      out.set(f, off);
      off += f.length;
    }
    this.pending = [];
    this.pendingLen = 0;
    let sum = 0;
    for (let i = 0; i < out.length; i++) sum += out[i]! * out[i]!;
    this.onLevel(Math.sqrt(sum / out.length));
    this.onChunk(this.sessionId, out);
  }

  /** Flush the tail and release the microphone. Returns the session that was stopped. */
  async stop(): Promise<string | null> {
    const id = this.sessionId;
    this.flush();
    this.sessionId = null;
    this.node?.port.close();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx && this.ctx.state !== "closed") await this.ctx.close();
    this.ctx = null;
    this.pending = [];
    this.pendingLen = 0;
    return id;
  }
}
