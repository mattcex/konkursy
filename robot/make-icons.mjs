// Generuje ikony PNG aplikacji (bez zależności): node robot/make-icons.mjs
// Ten sam wzór co site/icon.svg: zielony zaokrąglony kwadrat z białym „ptaszkiem”.
import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const GREEN = [0x1f, 0x88, 0x3d];
const WHITE = [255, 255, 255];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Kolor punktu w układzie 64×64 (jak w SVG) albo null poza ikoną. */
function sample(x, y, full) {
  const r = full ? 0 : 14;
  if (!full) {
    const cx = Math.min(Math.max(x, r), 64 - r);
    const cy = Math.min(Math.max(y, r), 64 - r);
    if (Math.hypot(x - cx, y - cy) > r) return null;
  }
  const d = Math.min(distToSegment(x, y, 18, 33.5, 27.5, 43), distToSegment(x, y, 27.5, 43, 46, 22.5));
  return d <= 3.5 ? WHITE : GREEN;
}

function png(size, full) {
  const SS = 4; // nadpróbkowanie dla gładkich krawędzi
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(((x + (sx + 0.5) / SS) / size) * 64, ((y + (sy + 0.5) / SS) / size) * 64, full);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (a) {
        raw[o] = Math.round(r / a);
        raw[o + 1] = Math.round(g / a);
        raw[o + 2] = Math.round(b / a);
      }
      raw[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // głębia
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = (name) => new URL(`../site/${name}`, import.meta.url);
await writeFile(out('icon-180.png'), png(180, true)); // iOS sam zaokrągla rogi
await writeFile(out('icon-192.png'), png(192, false));
await writeFile(out('icon-512.png'), png(512, true)); // „maskable” – pełne tło
console.log('Zapisano icon-180.png, icon-192.png, icon-512.png');
