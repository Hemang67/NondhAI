/** 16-bit PCM mono WAV encoding/decoding for Float32 samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(...bytes.subarray(off, off + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let off = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      channels = v.getUint16(off + 10, true);
      sampleRate = v.getUint32(off + 12, true);
      bits = v.getUint16(off + 22, true);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`unsupported WAV bit depth ${bits}`);
      const frames = Math.floor(size / 2 / channels);
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let acc = 0;
        for (let c = 0; c < channels; c++) acc += v.getInt16(off + 8 + (i * channels + c) * 2, true);
        out[i] = acc / channels / 0x8000;
      }
      return { samples: out, sampleRate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}
