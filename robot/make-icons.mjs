// Generuje ikony PNG Lootsy (strona + Android) bez zależności: node robot/make-icons.mjs
// Wzór jak w site/icon.svg: zielony zaokrąglony kwadrat z białym prezentem (układ 64×64).
import { writeFile, mkdir } from 'node:fs/promises';
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

const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/** Prezent w układzie 64×64: true = biały element. */
function glyph(x, y) {
  let white = inCircle(x, y, 26.5, 18.5, 5.6) || inCircle(x, y, 37.5, 18.5, 5.6) || inRect(x, y, 14, 24, 50, 31) || inRect(x, y, 17, 32.5, 47, 50.5);
  if (inCircle(x, y, 26.5, 18.5, 2.6) || inCircle(x, y, 37.5, 18.5, 2.6) || inRect(x, y, 30, 20, 34, 51)) white = false;
  return white;
}

/** Kolor punktu: tło 'rounded' | 'circle' | 'full' | 'none'; scale – wielkość wzoru względem obrazka. */
function sample(u, v, background, scale) {
  // u, v w zakresie 0..64 dla całego obrazka
  const x = 32 + (u - 32) / scale;
  const y = 32 + (v - 32) / scale;
  let bg = null;
  if (background === 'full') bg = GREEN;
  else if (background === 'rounded') {
    const r = 14;
    const cx = Math.min(Math.max(u, r), 64 - r);
    const cy = Math.min(Math.max(v, r), 64 - r);
    if (Math.hypot(u - cx, v - cy) <= r) bg = GREEN;
  } else if (background === 'circle') {
    if (inCircle(u, v, 32, 32, 32)) bg = GREEN;
  }
  if (glyph(x, y) && (bg || background === 'none')) return WHITE;
  return bg;
}

function png(size, background, scale = 1) {
  const SS = 4; // nadpróbkowanie dla gładkich krawędzi
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(((px + (sx + 0.5) / SS) / size) * 64, ((py + (sy + 0.5) / SS) / size) * 64, background, scale);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
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

async function save(rel, data) {
  const url = new URL(`../${rel}`, import.meta.url);
  await mkdir(new URL('.', url), { recursive: true });
  await writeFile(url, data);
}

// Strona (PWA)
await save('site/icon-180.png', png(180, 'full')); // iOS sam zaokrągla rogi
await save('site/icon-192.png', png(192, 'rounded'));
await save('site/icon-512.png', png(512, 'full')); // „maskable” – pełne tło

// Android: ikony klasyczne, okrągłe i warstwa pierwszego planu ikony adaptacyjnej (108 dp, widoczne 72 dp)
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, k] of Object.entries(DENSITIES)) {
  const dir = `android/app/src/main/res/mipmap-${name}`;
  await save(`${dir}/ic_launcher.png`, png(Math.round(48 * k), 'rounded'));
  await save(`${dir}/ic_launcher_round.png`, png(Math.round(48 * k), 'circle'));
  await save(`${dir}/ic_launcher_foreground.png`, png(Math.round(108 * k), 'none', 72 / 108));
}

// Sklep Google Play (512×512)
await save('android/store/icon-512.png', png(512, 'full'));
console.log('Zapisano ikony strony, Androida i sklepu.');
