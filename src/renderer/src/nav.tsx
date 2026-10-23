import { createContext, useContext } from "react";

export type Tab = "meetings" | "library" | "notes" | "history" | "search" | "people" | "dictionary" | "models" | "settings";

export interface NavTarget {
  tab: Tab;
  meetingId?: string;
  /** Opens the video editor on this edit (library tab). */
  projectId?: string;
  noteId?: string;
  at?: number;
  query?: string;
}

export const NavContext = createContext<(t: NavTarget) => void>(() => {});
export const useNav = () => useContext(NavContext);

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${s} s`;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
}

/** Stable, readable color per speaker key. */
export function speakerColor(key: string): string {
  if (key === "me") return "var(--accent)";
  const palette = ["#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#fb7185", "#2dd4bf", "#c084fc"];
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}

export const CLIP_KIND = { screen: "Entire screen", window: "Window", region: "Region", imported: "Imported" } as const;

/**
 * URL of a meeting's media for <audio>/<video>/<img>: the recording itself, or a sub-path
 * (a clip id, "edit/<id>", "asset/<file>").
 */
export const mediaUrl = (meetingId: string, ...path: string[]) =>
  [window.vd.mediaBase(), meetingId, ...path].map((p, i) => (i === 0 ? p : encodeURIComponent(p))).join("/");
