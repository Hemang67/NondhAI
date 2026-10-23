import { describe, expect, it } from "vitest";
import { displaySize, importMode, parseProbe } from "@shared/video/probe";

const phone = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_1234.MOV':
  Duration: 00:00:12.53, start: 0.000000, bitrate: 15925 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 15600 kb/s, 29.98 fps, 30 tbr, 600 tbn (default)
      Metadata:
        handler_name    : Core Media Video
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 175 kb/s (default)`;

const web = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'demo.mp4':
  Duration: 00:02:03.40, start: 0.000000, bitrate: 1200 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], 1000 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)`;

const silentWebm = `Input #0, matroska,webm, from 'screen.webm':
  Duration: 00:00:08.00, start: 0.000000, bitrate: 1136 kb/s
  Stream #0:0: Video: vp8, yuv420p(tv, smpte170m/smpte170m/bt709, progressive), 960x540, SAR 1:1 DAR 16:9, 15 fps, 15 tbr, 1k tbn (default)`;

const avi = `Input #0, avi, from 'old.avi':
  Duration: 00:00:30.00, start: 0.000000, bitrate: 2000 kb/s
  Stream #0:0: Video: mpeg4 (Simple Profile) (XVID / 0x44495658), yuv420p, 640x480 [SAR 1:1 DAR 4:3], 1800 kb/s, 25 fps, 25 tbr, 25 tbn
  Stream #0:1: Audio: mp3 (U[0][0][0] / 0x0055), 44100 Hz, stereo, fltp, 128 kb/s`;

describe("parseProbe", () => {
  it("reads duration, codecs, size, pixel format and rotation", () => {
    const p = parseProbe(phone);
    expect(p.durationMs).toBe(12530);
    expect(p.video).toEqual({ codec: "hevc", width: 1920, height: 1080, pixFmt: "yuv420p10le", rotation: 270 });
    expect(p.audio).toEqual({ codec: "aac" });
    expect(displaySize(p)).toEqual({ width: 1080, height: 1920 }); // a portrait phone video
  });

  it("handles files without sound", () => {
    const p = parseProbe(silentWebm);
    expect(p.audio).toBeNull();
    expect(p.video).toMatchObject({ codec: "vp8", width: 960, height: 540, rotation: 0 });
  });

  it("finds nothing in a file without video", () => {
    expect(parseProbe("Input #0, mp3\n  Duration: 00:01:00.00\n  Stream #0:0: Audio: mp3, 44100 Hz").video).toBeNull();
  });
});

describe("importMode", () => {
  it("keeps files the player can already play, converts the rest", () => {
    expect(importMode(parseProbe(web))).toBe("mp4");
    expect(importMode(parseProbe(silentWebm))).toBe("webm");
    expect(importMode(parseProbe(phone))).toBe("convert"); // HEVC 10-bit
    expect(importMode(parseProbe(avi))).toBe("convert");
  });

  it("refuses files without video", () => {
    expect(() => importMode(parseProbe("Duration: 00:00:05.00\n  Stream #0:0: Audio: aac"))).toThrow(/no video/);
  });
});
