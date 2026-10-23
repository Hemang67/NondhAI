// Builds every app icon from the logo artwork (resources/logo-source.png): the rounded square
// is cropped out of the glow around it, given transparent rounded corners, and scaled to each
// size. Writes icon.png / icon.ico (window, taskbar, installer), the tray icons, and the
// in-app copy. Uses the bundled ffmpeg; no other image tools needed.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const res = join(root, "resources");
const ffmpeg = createRequire(import.meta.url)("ffmpeg-static");
const tmp = mkdtempSync(join(tmpdir(), "nondh-icons-"));
const run = (args) => execFileSync(ffmpeg, ["-y", "-v", "error", ...args]);

// The artwork's rounded square spans about 87..1167 px of the 1254 px source.
const CROP = "crop=1080:1080:87:87";
const S = 1024; // master size
const R = 215; // corner radius at the master size
const rounded = `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip(${R}+0.5-hypot(max(max(${R}-X,X-(${S - 1}-${R})),0),max(max(${R}-Y,Y-(${S - 1}-${R})),0)),0,1)'`;
const master = join(tmp, "master.png");
run(["-i", join(res, "logo-source.png"), "-vf", `${CROP},scale=${S}:${S}:flags=lanczos,format=rgba,${rounded}`, master]);

const sized = (size) => {
  const out = join(tmp, `${size}.png`);
  run(["-i", master, "-vf", `scale=${size}:${size}:flags=lanczos`, out]);
  return readFileSync(out);
};

/** The same icon with a red "recording" dot (white ring) in the bottom-right corner. */
const recording = (size) => {
  const out = join(tmp, `rec-${size}.png`);
  const d = Math.round(size * 0.5); // dot diameter
  const dot = `format=rgba,geq=r='if(lt(hypot(X-${d / 2 - 0.5},Y-${d / 2 - 0.5}),${d / 2 - size * 0.08}),239,255)':g='if(lt(hypot(X-${d / 2 - 0.5},Y-${d / 2 - 0.5}),${d / 2 - size * 0.08}),68,255)':b='if(lt(hypot(X-${d / 2 - 0.5},Y-${d / 2 - 0.5}),${d / 2 - size * 0.08}),68,255)':a='255*clip(${d / 2}-hypot(X-${d / 2 - 0.5},Y-${d / 2 - 0.5}),0,1)'`;
  run([
    "-i", master, "-f", "lavfi", "-i", `color=c=black:s=${d}x${d}`,
    "-filter_complex", `[0]scale=${size}:${size}:flags=lanczos[i];[1]${dot}[d];[i][d]overlay=${size - d}:${size - d}`,
    "-frames:v", "1", out,
  ]);
  return readFileSync(out);
};

/** .ico with PNG-compressed entries (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

try {
  writeFileSync(join(res, "icon.ico"), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: sized(size) }))));
  const big = sized(256);
  writeFileSync(join(res, "icon.png"), big);
  writeFileSync(join(root, "src", "renderer", "public", "icon.png"), big);
  writeFileSync(join(res, "tray.png"), sized(32));
  writeFileSync(join(res, "tray-recording.png"), recording(32));
  console.log("icons written to", res);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
