import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from "react";
import { clampRect, zoomLayout, ZOOM_FADE, type BlurBox, type NRect, type ProjectSpec, type ZoomBox } from "@shared/video/project";
import { cx } from "../../components/ui";
import { mediaUrl } from "../../nav";

export type Selection = { kind: "blur" | "zoom" | "text" | "image" | "sub" | "segment" | "track"; id: string } | null;
export type DrawMode = "blur" | "crop" | "zoom" | null;

/** URL for a file added to an edit (copied into the meeting's video-assets folder). */
export const assetUrl = (meetingId: string, file: string) => mediaUrl(meetingId, "asset", file.split(/[\\/]/).pop()!);

const within = (t: number, x: { start: number; end: number }) => t >= x.start && t < x.end;

/**
 * The preview: the current clip drawn the way the export will be (scaled into the first clip's
 * frame, then cropped), with blur boxes, text, images and subtitles laid over it. Boxes can be
 * drawn, moved and resized directly on the picture.
 */
export function Preview({
  spec,
  base,
  meetingId,
  t,
  video,
  selection,
  onSelect,
  draw,
  onDrawn,
  update,
}: {
  spec: ProjectSpec;
  base: { width: number; height: number };
  meetingId: string;
  t: number;
  video: RefObject<HTMLVideoElement | null>;
  selection: Selection;
  onSelect: (s: Selection) => void;
  draw: DrawMode;
  onDrawn: (r: NRect | null) => void;
  update: (fn: (s: ProjectSpec) => ProjectSpec, key: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState({ w: 640, h: 360 });
  const [drawing, setDrawing] = useState<NRect | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // While drawing the crop, show the whole frame; otherwise show what the export will contain.
  const cropping = draw === "crop";
  const crop = cropping ? null : spec.crop;
  const view = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const outW = base.width * view.w;
  const outH = base.height * view.h;
  const scale = Math.min(avail.w / outW, avail.h / outH);
  const W = Math.max(1, Math.floor(outW * scale));
  const H = Math.max(1, Math.floor(outH * scale));
  const exportScale = W / (base.width * (spec.crop?.w ?? 1)); // preview px per export px

  /** Pointer position as a fraction of the stage. */
  const pos = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const startDraw = (e: RPointerEvent) => {
    if (!draw) return;
    e.preventDefault();
    const p0 = pos(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const p = pos(ev);
      setDrawing({ x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const p = pos(ev);
      const r = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
      setDrawing(null);
      onDrawn(r.w > 0.01 && r.h > 0.01 ? clampRect(r) : null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const sel = (kind: NonNullable<Selection>["kind"], id: string) => selection?.kind === kind && selection.id === id;
  const sub = spec.subtitles.burnIn ? spec.subtitles.lines.find((l) => within(t, l)) : undefined;
  // A zoom plays as it will export, except while it is selected: then the plain frame is shown so
  // its area can be moved and resized.
  const zooms = spec.zooms ?? [];
  const selZoom = zooms.find((z) => sel("zoom", z.id));
  const liveZoom = !draw && !selZoom ? zooms.find((z) => within(t, z)) : undefined;

  return (
    <div ref={host} className="flex h-full w-full items-center justify-center overflow-hidden">
      <div
        ref={stage}
        className={cx("relative select-none overflow-hidden bg-black", draw && "cursor-crosshair")}
        style={{ width: W, height: H }}
        onPointerDown={(e) => {
          if (draw) startDraw(e);
          else if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.frame) onSelect(null);
        }}
      >
        {/* The base frame, positioned so the crop fills the stage. */}
        <div
          data-frame="1"
          className="absolute"
          style={{ width: W / view.w, height: H / view.h, left: (-view.x * W) / view.w, top: (-view.y * H) / view.h }}
        >
          <video ref={video} muted playsInline data-frame="1" className="pointer-events-none size-full object-contain" />
        </div>

        {/* While cropping, the current crop is outlined on the whole frame. */}
        {cropping && spec.crop && !drawing && (
          <div className="pointer-events-none absolute border-2 border-dashed border-sky-400" style={rectStyle(spec.crop)}>
            <span className="absolute left-0 top-0 rounded-br bg-sky-500 px-1 text-[10px] text-white">Current crop</span>
          </div>
        )}

        {liveZoom && (
          <ZoomView
            zoom={liveZoom}
            t={t}
            video={video}
            view={view}
            W={W}
            H={H}
            blurs={spec.blurs.filter((b) => !b.suggested && within(t, b))}
            exportScale={exportScale}
            onSelect={() => onSelect({ kind: "zoom", id: liveZoom.id })}
          />
        )}

        {selZoom && !cropping && (
          <EditableRect
            rect={selZoom.rect}
            stage={stage}
            selected
            disabled={!!draw}
            onSelect={() => {}}
            onChange={(rect) => update((s) => ({ ...s, zooms: (s.zooms ?? []).map((x) => (x.id === selZoom.id ? { ...x, rect } : x)) }), `zoom-rect-${selZoom.id}`)}
            className={cx("outline-2 outline-dashed outline-fuchsia-400", !within(t, selZoom) && "opacity-50")}
          >
            <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-fuchsia-500 px-1 text-[10px] text-white">Zoom area · click away to see it magnified</span>
          </EditableRect>
        )}

        {/* Blurs: real blur in the preview; suggestions are outlined until accepted. While a zoom
            shows, it draws the blurs itself. */}
        {!cropping && !liveZoom && spec.blurs.map((b) => {
          const active = within(t, b);
          const isSel = sel("blur", b.id);
          if (!active && !isSel) return null;
          return (
            <EditableRect
              key={b.id}
              rect={b.rect}
              stage={stage}
              selected={isSel}
              disabled={!!draw}
              onSelect={() => onSelect({ kind: "blur", id: b.id })}
              onChange={(rect) => update((s) => ({ ...s, blurs: s.blurs.map((x) => (x.id === b.id ? { ...x, rect } : x)) }), `blur-rect-${b.id}`)}
              className={cx(b.suggested ? "outline-2 outline-dashed outline-amber-400" : "", !active && "opacity-40")}
              style={{ backdropFilter: `blur(${Math.max(2, b.strength * exportScale * 0.8)}px)`, WebkitBackdropFilter: `blur(${Math.max(2, b.strength * exportScale * 0.8)}px)` }}
            >
              {b.suggested && <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-amber-500 px-1 text-[10px] text-black">Suggested · {b.suggested.reason}</span>}
            </EditableRect>
          );
        })}

        {!cropping && spec.images.map((img) => {
          const active = within(t, img);
          const isSel = sel("image", img.id);
          if (!active && !isSel) return null;
          return (
            <EditableRect
              key={img.id}
              rect={{ x: img.x, y: img.y, w: img.w, h: 0 }}
              stage={stage}
              selected={isSel}
              disabled={!!draw}
              keepHeight
              onSelect={() => onSelect({ kind: "image", id: img.id })}
              onChange={(r) => update((s) => ({ ...s, images: s.images.map((x) => (x.id === img.id ? { ...x, x: r.x, y: r.y, w: r.w } : x)) }), `img-rect-${img.id}`)}
              className={cx(!active && "opacity-40")}
            >
              <img src={assetUrl(meetingId, img.file)} alt="" draggable={false} className="pointer-events-none block w-full" />
            </EditableRect>
          );
        })}

        {!cropping && spec.texts.map((tx) => {
          const active = within(t, tx);
          const isSel = sel("text", tx.id);
          if (!active && !isSel) return null;
          const size = Math.max(6, tx.size * H);
          return (
            <EditableRect
              key={tx.id}
              rect={{ x: tx.x, y: tx.y, w: 0, h: 0 }}
              stage={stage}
              selected={isSel}
              disabled={!!draw}
              moveOnly
              onSelect={() => onSelect({ kind: "text", id: tx.id })}
              onChange={(r) => update((s) => ({ ...s, texts: s.texts.map((x) => (x.id === tx.id ? { ...x, x: r.x, y: r.y } : x)) }), `text-pos-${tx.id}`)}
              className={cx(!active && "opacity-40")}
            >
              <div
                className="whitespace-pre leading-tight"
                style={{
                  fontSize: size,
                  color: tx.color,
                  fontFamily: "Segoe UI, sans-serif",
                  background: tx.background ? "rgba(0,0,0,0.55)" : undefined,
                  padding: tx.background ? size * 0.3 : 0,
                  margin: tx.background ? -size * 0.3 : 0,
                }}
              >
                {tx.text || " "}
              </div>
            </EditableRect>
          );
        })}

        {!cropping && sub && (
          <div className="pointer-events-none absolute inset-x-0 flex justify-center px-[4%]" style={{ bottom: H * 0.06 }}>
            <div
              className="max-w-full rounded-sm text-center leading-snug text-white"
              style={{ fontSize: Math.max(9, H * 0.045), background: "rgba(0,0,0,0.6)", padding: `${H * 0.012}px ${H * 0.016}px` }}
            >
              {sub.speaker ? `${sub.speaker}: ${sub.text}` : sub.text}
            </div>
          </div>
        )}

        {drawing && <div className="pointer-events-none absolute border-2 border-sky-400 bg-sky-400/20" style={rectStyle(drawing)} />}
        {draw && !drawing && (
          <div className="pointer-events-none absolute inset-x-0 top-2 text-center">
            <span className="rounded bg-black/70 px-2 py-1 text-xs text-white">
              {draw === "crop" ? "Drag over the part of the picture to keep" : draw === "zoom" ? "Drag over the area to magnify" : "Drag over the area to blur"} · Esc to cancel
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The zoom as the export draws it, on a canvas over the video, from the same zoomLayout: for a
 * spotlight the whole frame blurred and dimmed with the area scaled up in the middle; for a lens or
 * glass the frame as it is with the framed, enlarged area over it. Blur boxes inside the area stay
 * blurred. Faded in and out at the ends.
 */
function ZoomView({
  zoom,
  t,
  video,
  view,
  W,
  H,
  blurs,
  exportScale,
  onSelect,
}: {
  zoom: ZoomBox;
  t: number;
  video: RefObject<HTMLVideoElement | null>;
  view: NRect;
  W: number;
  H: number;
  blurs: BlurBox[];
  exportScale: number;
  onSelect: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const props = useRef({ zoom, view, W, H, blurs, exportScale });
  props.current = { zoom, view, W, H, blurs, exportScale };

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      const v = video.current;
      if (!c || !v || !v.videoWidth) return;
      const { zoom: z, view: vw, W, H, blurs, exportScale } = props.current;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Where the video is drawn in stage pixels (object-contain inside the uncropped frame).
      const fw = W / vw.w;
      const fh = H / vw.h;
      const s = Math.min(fw / v.videoWidth, fh / v.videoHeight);
      const ox = (fw - v.videoWidth * s) / 2 - vw.x * fw;
      const oy = (fh - v.videoHeight * s) / 2 - vw.y * fh;
      /** A rectangle of the stage (normalized) → the same pixels of the video. */
      const src = (r: NRect) => [(r.x * W - ox) / s, (r.y * H - oy) / s, (r.w * W) / s, (r.h * H) / s] as const;

      // The same geometry the export uses, in stage pixels.
      const L = zoomLayout(z, W, H);
      const area = { x: L.src.x / W, y: L.src.y / H, w: L.src.w / W, h: L.src.h / H };
      const d = L.dst;
      const glass = L.style === "glass";
      const shape = (grow: number) => {
        ctx.beginPath();
        if (glass) ctx.arc(d.x + d.w / 2, d.y + d.h / 2, d.w / 2 + grow, 0, Math.PI * 2);
        else if (L.style === "lens") ctx.roundRect(d.x - grow, d.y - grow, d.w + 2 * grow, d.h + 2 * grow, L.corner + grow);
        else ctx.rect(d.x, d.y, d.w, d.h);
      };

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      if (L.style === "spotlight") ctx.filter = `blur(${Math.max(0, z.blur * exportScale * 0.8)}px) brightness(0.8)`;
      ctx.drawImage(v, ox, oy, v.videoWidth * s, v.videoHeight * s);
      ctx.filter = "none";

      if (L.style !== "spotlight") {
        // Shadow, handle (glass), then the white frame.
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.45)";
        ctx.shadowBlur = L.shadow * 2;
        ctx.shadowOffsetY = L.shadow / 2;
        if (glass) {
          const c = d.w / 2;
          const a0 = c + L.border / 2;
          const a1 = c + L.border + d.w * 0.45;
          ctx.strokeStyle = "#2b2b2b";
          ctx.lineWidth = Math.max(6, d.w * 0.09);
          ctx.beginPath();
          ctx.moveTo(d.x + c + a0 * Math.SQRT1_2, d.y + c + a0 * Math.SQRT1_2);
          ctx.lineTo(d.x + c + a1 * Math.SQRT1_2, d.y + c + a1 * Math.SQRT1_2);
          ctx.stroke();
        }
        ctx.fillStyle = "#fff";
        shape(L.border);
        ctx.fill();
        ctx.restore();
      }

      // The magnified area, clipped to the lens or glass shape.
      ctx.save();
      shape(0);
      ctx.clip();
      ctx.drawImage(v, ...src(area), d.x, d.y, d.w, d.h);
      // Blur boxes inside the area stay blurred, magnified like everything else.
      const k = d.w / L.src.w;
      for (const b of blurs) {
        const x0 = Math.max(b.rect.x, area.x);
        const y0 = Math.max(b.rect.y, area.y);
        const x1 = Math.min(b.rect.x + b.rect.w, area.x + area.w);
        const y1 = Math.min(b.rect.y + b.rect.h, area.y + area.h);
        if (x1 <= x0 || y1 <= y0) continue;
        const part = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        const dx = d.x + ((part.x - area.x) / area.w) * d.w;
        const dy = d.y + ((part.y - area.y) / area.h) * d.h;
        const dw = (part.w / area.w) * d.w;
        const dh = (part.h / area.h) * d.h;
        ctx.save();
        ctx.beginPath();
        ctx.rect(dx, dy, dw, dh);
        ctx.clip();
        ctx.filter = `blur(${Math.max(2, b.strength * exportScale * 0.8 * k)}px)`;
        ctx.drawImage(v, ...src(part), dx, dy, dw, dh);
        ctx.restore();
      }
      ctx.restore();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [video]);

  const opacity = Math.max(0, Math.min(1, (t - zoom.start) / ZOOM_FADE, (zoom.end - t) / ZOOM_FADE));
  return (
    <canvas
      ref={canvas}
      className="absolute inset-0 cursor-pointer"
      style={{ width: W, height: H, opacity }}
      title="Zoom: click to edit its area"
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    />
  );
}

const rectStyle = (r: NRect) => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });

/** A box on the stage that can be selected, dragged and (unless moveOnly) resized from its corner. */
function EditableRect({
  rect,
  stage,
  selected,
  disabled,
  moveOnly,
  keepHeight,
  onSelect,
  onChange,
  className,
  style,
  children,
}: {
  rect: NRect;
  stage: RefObject<HTMLDivElement | null>;
  selected: boolean;
  disabled?: boolean;
  moveOnly?: boolean;
  keepHeight?: boolean;
  onSelect: () => void;
  onChange: (r: NRect) => void;
  className?: string;
  style?: React.CSSProperties;
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = (e: RPointerEvent, mode: "move" | "resize") => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect();
    const s = stage.current!.getBoundingClientRect();
    const b = box.current!.getBoundingClientRect();
    // Measured size for elements sized by their content (text, images).
    const r0 = { ...rect, w: rect.w || b.width / s.width, h: rect.h || b.height / s.height };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / s.width;
      const dy = (ev.clientY - y0) / s.height;
      if (mode === "move") {
        const next = clampRect({ ...r0, x: r0.x + dx, y: r0.y + dy }, 0.005);
        onChange({ ...rect, x: next.x, y: next.y });
      } else {
        const w = Math.max(0.02, Math.min(1 - r0.x, r0.w + dx));
        const h = keepHeight ? 0 : Math.max(0.02, Math.min(1 - r0.y, r0.h + dy));
        onChange({ ...rect, w, h });
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      ref={box}
      className={cx("absolute", !disabled && "cursor-move", selected && "ring-2 ring-sky-400", className)}
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: rect.w ? `${rect.w * 100}%` : undefined,
        height: rect.h ? `${rect.h * 100}%` : undefined,
        ...style,
      }}
      onPointerDown={(e) => drag(e, "move")}
    >
      {children}
      {selected && !moveOnly && !disabled && (
        <div
          aria-label="Resize"
          className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-sm border border-white bg-sky-500"
          onPointerDown={(e) => drag(e, "resize")}
        />
      )}
    </div>
  );
}
