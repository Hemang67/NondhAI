import type { BlurBox, NRect } from "./project";
import { newId } from "./project";

/** OCR output for one sampled frame (pixel boxes). */
export interface OcrWord {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface OcrFrame {
  time: number; // timeline seconds
  width: number;
  height: number;
  lines: Array<{ words: OcrWord[] }>;
}

const LABEL = /^(password|passwd|pwd|passcode|pass|pin|secret|token|apikey|api[-_]?key|key|otp|cvv|cvc|credentials?|private)$/i;
const LABEL_PAIRS: Array<[RegExp, RegExp]> = [
  [/^api$/i, /^key:?$/i],
  [/^access$/i, /^(key|token):?$/i],
  [/^secret$/i, /^key:?$/i],
  [/^private$/i, /^key:?$/i],
  [/^client$/i, /^secret:?$/i],
  [/^card$/i, /^(number|no\.?):?$/i],
];

const KNOWN_SECRET = [
  /^sk-[A-Za-z0-9_-]{10,}/, // OpenAI / Anthropic style keys
  /^sk-ant-/,
  /^gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /^AKIA[0-9A-Z]{12,}/, // AWS access keys
  /^xox[abpr]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, // JWT
  /^AIza[0-9A-Za-z_-]{20,}/, // Google API keys
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** A string that looks like a secret on its own (no label needed). */
export function looksSecret(word: string): string | null {
  const w = word.replace(/[",;()[\]{}]/g, "");
  if (KNOWN_SECRET.some((re) => re.test(w))) return "API key or token";
  if (/^[•●*]{4,}$/.test(w)) return "masked password";
  // High-entropy-looking: long, mixes letters and digits, no spaces (not a plain word or number).
  if (w.length >= 20 && /[A-Za-z]/.test(w) && /\d/.test(w) && /^[A-Za-z0-9+/=_\-.]+$/.test(w) && !/^\d+$/.test(w)) return "secret-looking string";
  return null;
}

function cardNumber(words: OcrWord[], i: number): number {
  // 13–19 digits, possibly split into groups ("4111 1111 1111 1111").
  let digits = "";
  let j = i;
  while (j < words.length && /^\d{2,6}$/.test(words[j]!.t) && digits.length < 19) {
    digits += words[j]!.t;
    j++;
    if (digits.length >= 13 && luhn(digits)) return j - i;
  }
  return 0;
}

const unionPx = (ws: OcrWord[]) => {
  const x = Math.min(...ws.map((w) => w.x));
  const y = Math.min(...ws.map((w) => w.y));
  return { x, y, w: Math.max(...ws.map((w) => w.x + w.w)) - x, h: Math.max(...ws.map((w) => w.y + w.h)) - y };
};

export interface Hit {
  rect: NRect;
  reason: string;
  text: string;
}

/** Sensitive spans in one frame, as padded normalized rectangles. */
export function findSensitive(frame: OcrFrame): Hit[] {
  const hits: Hit[] = [];
  const add = (ws: OcrWord[], reason: string) => {
    if (!ws.length) return;
    const u = unionPx(ws);
    const pad = Math.max(4, u.h * 0.35);
    hits.push({
      rect: {
        x: Math.max(0, (u.x - pad) / frame.width),
        y: Math.max(0, (u.y - pad) / frame.height),
        w: Math.min(1, (u.w + pad * 2) / frame.width),
        h: Math.min(1, (u.h + pad * 2) / frame.height),
      },
      reason,
      text: ws.map((w) => w.t).join(" "),
    });
  };
  for (const { words } of frame.lines) {
    const used = new Set<number>();
    for (let i = 0; i < words.length; i++) {
      if (used.has(i)) continue;
      const w = words[i]!;
      const bare = w.t.replace(/[:=]+$/, "");
      // "Password: hunter2" / "API key = sk-..." → blur what follows the label on that line.
      const pair = LABEL_PAIRS.some(([a, b]) => a.test(bare) && words[i + 1] && b.test(words[i + 1]!.t));
      if (LABEL.test(bare) || pair) {
        const valueStart = i + (pair ? 2 : 1) + (words[i + (pair ? 2 : 1)]?.t.match(/^[:=]+$/) ? 1 : 0);
        // Inline value: "password:hunter2"
        const inline = w.t.match(/^[^:=]+[:=](.+)$/);
        const value = words.slice(valueStart, valueStart + 4);
        const label = pair ? `${bare} ${words[i + 1]!.t.replace(/[:=]+$/, "")}` : bare;
        for (let k = i; k < valueStart; k++) used.add(k); // the label words themselves
        if (inline) {
          add([w], `value after "${label}"`);
          used.add(i);
        } else if (value.length) {
          add(value, `value after "${label}"`);
          value.forEach((_, k) => used.add(valueStart + k));
        }
        continue;
      }
      if (used.has(i)) continue;
      const card = cardNumber(words, i);
      if (card) {
        add(words.slice(i, i + card), "card number");
        for (let k = 0; k < card; k++) used.add(i + k);
        i += card - 1;
        continue;
      }
      const reason = looksSecret(w.t);
      if (reason) add([w], reason);
    }
  }
  return hits;
}

export const iou = (a: NRect, b: NRect) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
};

/**
 * Turn per-frame hits into blur suggestions: the same spot seen in consecutive samples becomes
 * one box covering the whole stretch (plus the sampling interval on each side, so nothing
 * flashes before or after the blur).
 */
export function suggestBlurs(frames: OcrFrame[], interval: number): BlurBox[] {
  const tracks: Array<{ rect: NRect; start: number; end: number; reason: string; text: string }> = [];
  for (const f of [...frames].sort((a, b) => a.time - b.time)) {
    for (const h of findSensitive(f)) {
      const t = tracks.find((tr) => iou(tr.rect, h.rect) > 0.3 && f.time - tr.end <= interval * 1.5);
      if (t) {
        // Grow to cover slight movement.
        const x = Math.min(t.rect.x, h.rect.x);
        const y = Math.min(t.rect.y, h.rect.y);
        t.rect = { x, y, w: Math.max(t.rect.x + t.rect.w, h.rect.x + h.rect.w) - x, h: Math.max(t.rect.y + t.rect.h, h.rect.y + h.rect.h) - y };
        t.end = f.time;
      } else tracks.push({ rect: h.rect, start: f.time, end: f.time, reason: h.reason, text: h.text });
    }
  }
  return tracks.map((t) => ({
    id: newId("b"),
    rect: t.rect,
    start: Math.max(0, t.start - interval),
    end: t.end + interval,
    strength: 24,
    suggested: { reason: t.reason, text: t.text },
  }));
}

/**
 * OCR runs on the uncropped frame, but blur boxes live in the exported (cropped) frame.
 * Returns null when the box falls outside the crop.
 */
export function intoCrop(r: NRect, crop: NRect | null): NRect | null {
  if (!crop) return r;
  const x0 = Math.max(r.x, crop.x);
  const y0 = Math.max(r.y, crop.y);
  const x1 = Math.min(r.x + r.w, crop.x + crop.w);
  const y1 = Math.min(r.y + r.h, crop.y + crop.h);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: (x0 - crop.x) / crop.w, y: (y0 - crop.y) / crop.h, w: (x1 - x0) / crop.w, h: (y1 - y0) / crop.h };
}

/** New suggestions minus the ones already covered by an existing blur at the same time. */
export function dropCovered(suggestions: BlurBox[], existing: BlurBox[]): BlurBox[] {
  return suggestions.filter(
    (s) => !existing.some((b) => !b.suggested && b.start <= s.start + 0.5 && b.end >= s.end - 0.5 && iou(b.rect, s.rect) > 0.4),
  );
}
