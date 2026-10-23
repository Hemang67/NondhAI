import { useEffect, useRef, useState } from "react";
import { dragRect, fitWithin, regionToVideoCrop, type Rect } from "@shared/screen";

const FPS = 15;

interface Job {
  clipId: string;
  stop: () => void;
}

/**
 * Hidden window that records the screen, a window, or a region of a display. Electron gives a
 * desktop stream for the chosen source; regions are cropped through a canvas. Chunks go to the
 * main process every second so nothing is lost if the app dies mid-clip.
 */
export function ScreenRecorderHost() {
  const job = useRef<Job | null>(null);

  useEffect(() => {
    const offBegin = window.vd.on("screen:begin", async ({ clipId, sourceId, region, display }) => {
      job.current?.stop();
      try {
        const max = region ? { maxWidth: 3840, maxHeight: 2160 } : { maxWidth: 1920, maxHeight: 1080 };
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId, maxFrameRate: FPS, ...max } } as MediaTrackConstraints,
        });
        const video = document.createElement("video");
        video.muted = true;
        video.srcObject = stream;
        await video.play();
        // Every clip is redrawn through a canvas at a steady frame rate: desktop capture only
        // delivers frames when the screen changes, so a still window would record a clip far
        // shorter than real time and drift out of sync with the meeting audio. The canvas also
        // does the cropping for regions.
        const full = { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
        const crop = region && display ? regionToVideoCrop(region, display, { width: video.videoWidth, height: video.videoHeight }) : full;
        const size = fitWithin(crop.width, crop.height, 1920, 1080);
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const ctx = canvas.getContext("2d")!;
        const draw = () => ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height);
        draw();
        // A timer, not requestAnimationFrame: this window is hidden and rAF would not run.
        const timer = setInterval(draw, 1000 / FPS);
        const recStream = canvas.captureStream(FPS);
        const rec = new MediaRecorder(recStream, {
          mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm",
          videoBitsPerSecond: 1_500_000,
        });
        let sending = Promise.resolve();
        rec.ondataavailable = (e) => {
          if (!e.data.size) return;
          sending = sending.then(async () => window.vd.send("screen:chunk", clipId, await e.data.arrayBuffer()));
        };
        const finish = () => {
          clearInterval(timer);
          stream.getTracks().forEach((t) => t.stop());
          recStream.getTracks().forEach((t) => t.stop());
          void sending.then(() => window.vd.send("screen:ended", clipId, size.width, size.height));
          if (job.current?.clipId === clipId) job.current = null;
        };
        rec.onstop = finish;
        // The captured window was closed or the display unplugged.
        stream.getVideoTracks()[0]?.addEventListener("ended", () => rec.state !== "inactive" && rec.stop());
        rec.start(1000);
        job.current = { clipId, stop: () => rec.state !== "inactive" && rec.stop() };
        window.vd.send("screen:started", clipId, null, size.width, size.height);
      } catch (err) {
        window.vd.send("screen:started", clipId, (err as Error).message || String(err), 0, 0);
      }
    });
    const offEnd = window.vd.on("screen:end", (clipId) => {
      if (job.current?.clipId === clipId) job.current.stop();
      else window.vd.send("screen:ended", clipId, 0, 0);
    });
    return () => {
      offBegin();
      offEnd();
    };
  }, []);
  return null;
}

/** Full-screen overlay: drag a rectangle to choose the region to record. Esc cancels. */
export function RegionPicker() {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("pill-root");
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") void window.vd.invoke("region:done", null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  return (
    <div
      className="fixed inset-0 cursor-crosshair select-none"
      style={{ background: rect ? "transparent" : "rgba(0,0,0,0.35)" }}
      onMouseDown={(e) => {
        setStart({ x: e.clientX, y: e.clientY });
        setRect({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
      }}
      onMouseMove={(e) => start && setRect(dragRect(start, { x: e.clientX, y: e.clientY }))}
      onMouseUp={() => {
        if (rect && rect.width >= 8 && rect.height >= 8) void window.vd.invoke("region:done", rect);
        setStart(null);
      }}
    >
      {rect && (
        <div
          className="absolute border-2 border-sky-400"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)" }}
        >
          <span className="absolute -top-6 left-0 rounded bg-sky-500 px-1.5 py-0.5 text-xs text-white">
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </span>
        </div>
      )}
      {!start && (
        <div className="pointer-events-none absolute left-1/2 top-8 -translate-x-1/2 rounded-lg bg-neutral-900/90 px-4 py-2 text-sm text-white shadow-lg">
          Drag to select the area to record · Esc to cancel
        </div>
      )}
    </div>
  );
}
