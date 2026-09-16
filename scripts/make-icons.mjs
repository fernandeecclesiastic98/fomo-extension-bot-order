// Génère les icônes PNG de l'extension sans dépendance (Chrome n'accepte pas le SVG pour
// l'icône d'action). Dessin : tuile accent #516AF6, flèche montante blanche et trait de seuil.
// Usage : npm run icons
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
mkdirSync(OUT, { recursive: true });

const ACCENT = [0x51, 0x6a, 0xf6];
const WHITE = [0xff, 0xff, 0xff];

/** Distance signée à un rectangle arrondi centré (coordonnées normalisées 0..1). */
function roundedRect(x, y, half, radius) {
  const qx = Math.abs(x - 0.5) - half + radius;
  const qy = Math.abs(y - 0.5) - half + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function segment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function shade(x, y) {
  const tile = roundedRect(x, y, 0.47, 0.2);
  if (tile > 0.01) return null;
  const stroke = 0.075;
  // Flèche : diagonale montante + deux branches de pointe, puis un trait de seuil pointillé en haut.
  const arrow = Math.min(
    segment(x, y, 0.26, 0.74, 0.7, 0.3),
    segment(x, y, 0.7, 0.3, 0.46, 0.3),
    segment(x, y, 0.7, 0.3, 0.7, 0.54),
  );
  const dashed = y > 0.18 && y < 0.22 && x > 0.2 && x < 0.8 && Math.floor((x - 0.2) / 0.1) % 2 === 0;
  return { tile, arrow: arrow - stroke / 2, dashed };
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const samples = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sj = 0; sj < samples; sj++) {
        for (let si = 0; si < samples; si++) {
          const x = (i + (si + 0.5) / samples) / size;
          const y = (j + (sj + 0.5) / samples) / size;
          const s = shade(x, y);
          if (!s || s.tile > 0) continue;
          const color = s.arrow <= 0 || (size >= 32 && s.dashed) ? WHITE : ACCENT;
          r += color[0];
          g += color[1];
          b += color[2];
          a += 1;
        }
      }
      const n = samples * samples;
      const o = (j * size + i) * 4;
      if (a) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
      }
      px[o + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, size, px);
}

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c;
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${size}.png`), render(size));
}
console.log(`Icônes écrites dans ${OUT}`);
