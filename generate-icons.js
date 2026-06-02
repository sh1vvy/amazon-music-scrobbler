// generate-icons.js — run once with: node generate-icons.js
// Creates icons/icon16.png, icon32.png, icon48.png, icon128.png
// No external dependencies required.

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 ────────────────────────────────────────────────────────────────────

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c;
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xFF];
  return ((c ^ 0xFFFFFFFF) >>> 0);
}

// ── PNG builder ───────────────────────────────────────────────────────────────

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length);
  const crc = Buffer.allocUnsafe(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function makePNG(size, pixelFn) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = ihdr[11] = ihdr[12] = 0;

  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(0); // filter: None
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelFn(x, y, size);
      rows.push(r, g, b);
    }
  }

  const compressed = zlib.deflateSync(Buffer.from(rows), { level: 9 });

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Icon design ───────────────────────────────────────────────────────────────
// Last.fm red circle with a white music-note silhouette

function pixel(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const r  = size / 2;

  // Distance from center
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist > r - 0.5) return [255, 255, 255]; // outside: white

  // Background: Last.fm red
  const bg = [213, 16, 7];

  // Music note shape (normalized to 0-1 grid within the circle)
  const nx = dx / r;  // -1..1
  const ny = dy / r;  // -1..1 (positive = down)

  const noteColor = [255, 255, 255];

  // Stem: thin vertical bar, right of center, top portion
  const stemX1 = 0.15, stemX2 = 0.30;
  const stemY1 = -0.72, stemY2 = 0.15;
  if (nx >= stemX1 && nx <= stemX2 && ny >= stemY1 && ny <= stemY2) return noteColor;

  // Note head: filled oval in lower-right of stem
  const headCx = 0.02, headCy = 0.25;
  const headRx  = size < 32 ? 0.35 : 0.30;
  const headRy  = size < 32 ? 0.22 : 0.18;
  const headAngle = -0.4; // slight tilt
  const cos = Math.cos(headAngle), sin = Math.sin(headAngle);
  const hnx = (nx - headCx) * cos + (ny - headCy) * sin;
  const hny = -(nx - headCx) * sin + (ny - headCy) * cos;
  if ((hnx / headRx) ** 2 + (hny / headRy) ** 2 <= 1) return noteColor;

  // Flag: curved stroke from top of stem
  const flagX = nx - stemX2;
  const flagYrel = ny - stemY1;
  if (flagX >= 0 && flagX <= 0.45 && flagYrel >= 0 && flagYrel <= 0.35) {
    const curve = 0.35 * (1 - Math.exp(-flagX * 5));
    if (Math.abs(flagYrel - curve) < (size < 32 ? 0.12 : 0.09)) return noteColor;
  }

  return bg;
}

// ── Write files ───────────────────────────────────────────────────────────────

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

for (const size of [16, 32, 48, 128]) {
  const buf = makePNG(size, pixel);
  const file = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(file, buf);
  console.log(`Created ${path.relative(__dirname, file)}  (${buf.length} bytes)`);
}
