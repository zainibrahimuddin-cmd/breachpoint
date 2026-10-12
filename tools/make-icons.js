// Renders the Breachpoint app icon (hexagon + lightning bolt) to PNG files with no dependencies.
// Usage: node tools/make-icons.js   -> writes icons/icon-{180,192,512}.png and icons/favicon-32.png
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// --- tiny PNG encoder ---
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// --- geometry in the logo's 32x32 design space (same shapes as the in-game logo) ---
const HEX = [[16, 2], [29, 9.5], [29, 22.5], [16, 30], [3, 22.5], [3, 9.5]];
const BOLT = [[11, 9], [17, 9], [14, 15], [19, 15], [11, 24], [13, 17], [9, 17]];
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const scalePoly = (poly, k, cx = 16, cy = 16) => poly.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
const HEX_IN = scalePoly(HEX, 0.82);
const HEX_FILL = scalePoly(HEX, 0.8);
const mix = (a, b, t) => a + (b - a) * t;

function render(size, opts = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;                        // 4x4 supersampling for smooth edges
  const pad = opts.pad ?? 0.17;        // logo occupies the middle of the tile
  const unit = size * (1 - pad * 2) / 32, off = size * pad;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const X = px + (sx + 0.5) / ss, Y = py + (sy + 0.5) / ss;
      // background: dark armour-grey with a warm glow behind the logo
      const ny = Y / size, d = Math.hypot(X / size - 0.5, Y / size - 0.48);
      let cr = mix(22, 8, ny), cg = mix(27, 10, ny), cb = mix(34, 13, ny);
      const glow = Math.max(0, 1 - d / 0.55) ** 2;
      cr += glow * 70; cg += glow * 30; cb += glow * 4;
      const lx = (X - off) / unit, ly = (Y - off) / unit;
      if (inPoly(lx, ly, HEX) && !inPoly(lx, ly, HEX_IN)) { cr = 255; cg = 138; cb = 30; }
      else if (inPoly(lx, ly, HEX_FILL)) { cr = cr * 0.55 + 6; cg = cg * 0.55 + 6; cb = cb * 0.55 + 8; }
      if (inPoly(lx, ly, BOLT)) { cr = 236; cg = 239; cb = 242; }
      r += cr; g += cg; b += cb;
    }
    const n = ss * ss, i = (py * size + px) * 4;
    buf[i] = Math.min(255, r / n); buf[i + 1] = Math.min(255, g / n); buf[i + 2] = Math.min(255, b / n); buf[i + 3] = 255;
  }
  return png(size, buf);
}

for (const [name, size, pad] of [['icon-180.png', 180, 0.17], ['icon-192.png', 192, 0.17], ['icon-512.png', 512, 0.17], ['icon-maskable-512.png', 512, 0.24], ['favicon-32.png', 32, 0.04]]) {
  fs.writeFileSync(path.join(OUT, name), render(size, { pad }));
  console.log('wrote', name);
}
