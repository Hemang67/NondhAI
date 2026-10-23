// Draws the Nondh AI icon (a microphone in a rounded square) as PNGs and a Windows .ico.
// No image dependencies: pixels are computed directly with anti-aliased signed distances.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "resources");
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sdRoundRect = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

function draw(size, { recording = false, bg = true } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size / 64;
  const accent = recording ? [239, 68, 68] : [56, 189, 248];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / s;
      const py = (y + 0.5) / s;
      let col = [0, 0, 0, 0];
      const blend = (c, d) => {
        const a = Math.max(0, Math.min(1, 0.5 - d * s));
        if (a <= 0) return;
        const na = a + col[3] * (1 - a);
        col = [0, 1, 2].map((i) => (c[i] * a + col[i] * col[3] * (1 - a)) / (na || 1)).concat(na);
      };
      if (bg) blend([17, 24, 39], sdRoundRect(px, py, 32, 32, 30, 30, 14));
      blend(accent, sdRoundRect(px, py, 32, 24, 8, 14, 8)); // capsule
      // cradle arc: ring segment below the capsule
      const ring = Math.abs(Math.hypot(px - 32, py - 26) - 15) - 2.6;
      blend(accent, py < 26 ? Math.max(ring, 26 - py) : ring);
      blend(accent, sdRoundRect(px, py, 32, 47, 2.6, 6, 1)); // stem
      blend(accent, sdRoundRect(px, py, 32, 54, 9, 2.6, 2.6)); // base
      const i = (y * size + x) * 4;
      buf[i] = Math.round(col[0]);
      buf[i + 1] = Math.round(col[1]);
      buf[i + 2] = Math.round(col[2]);
      buf[i + 3] = Math.round(col[3] * 255);
    }
  }
  return png(size, buf);
}

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

const sizes = [16, 24, 32, 48, 64, 128, 256];
const imgs = sizes.map((size) => ({ size, data: draw(size) }));
writeFileSync(join(out, "icon.ico"), ico(imgs));
writeFileSync(join(out, "icon.png"), draw(256));
writeFileSync(join(out, "tray.png"), draw(32));
writeFileSync(join(out, "tray-recording.png"), draw(32, { recording: true }));
console.log("icons written to", out);
