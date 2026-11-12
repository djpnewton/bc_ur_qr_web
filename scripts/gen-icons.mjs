// Generates the PWA icons from code so they stay in sync with the app theme.
// Usage: npm run icons
import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const SUPER = 4; // supersampling factor for cheap anti-aliasing

const MODULES = 25;
const MARGIN = 3;
const GRID = MODULES + MARGIN * 2;

/** Deterministic 32-bit PRNG so the icon never changes between runs. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds the QR-like module grid once; `true` means "light module". */
function buildGrid() {
  const grid = Array.from({ length: MODULES }, () => new Array(MODULES).fill(false));
  const reserved = Array.from({ length: MODULES }, () => new Array(MODULES).fill(false));

  const finder = (ox, oy) => {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const gx = ox + x;
        const gy = oy + y;
        if (gx < 0 || gy < 0 || gx >= MODULES || gy >= MODULES) continue;
        reserved[gy][gx] = true;
        const inside = x >= 0 && x <= 6 && y >= 0 && y <= 6;
        const ring = x === 0 || y === 0 || x === 6 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        grid[gy][gx] = inside && (ring || core);
      }
    }
  };
  finder(0, 0);
  finder(MODULES - 7, 0);
  finder(0, MODULES - 7);

  for (let i = 0; i < MODULES; i++) {
    reserved[6][i] = reserved[i][6] = true;
    grid[6][i] = i % 2 === 0;
    grid[i][6] = i % 2 === 0;
  }

  const rand = mulberry32(0x5ca1ab1e);
  for (let y = 0; y < MODULES; y++) {
    for (let x = 0; x < MODULES; x++) {
      if (reserved[y][x]) continue;
      grid[y][x] = rand() > 0.52;
    }
  }
  return grid;
}

const GRID_DATA = buildGrid();

function render(size, { maskable = false } = {}) {
  const s = size * SUPER;
  const png = new PNG({ width: s, height: s });
  const grid = GRID_DATA;

  const bgTop = [16, 24, 40];
  const bgBottom = [7, 10, 16];
  const radius = maskable ? 0 : s * 0.22;
  const inset = maskable ? 0 : s * 0.02;
  const w = s - inset * 2;

  // Maskable icons must keep content inside a centred 80% safe circle.
  const contentScale = maskable ? 0.82 : 1;
  const moduleSize = (w / GRID) * contentScale;
  const offset = (s - moduleSize * GRID) / 2;

  const insideRounded = (px, py) => {
    if (radius <= 0) return true;
    const x = px - inset;
    const y = py - inset;
    if (x < 0 || y < 0 || x > w || y > w) return false;
    const r = radius;
    if (x > r && x < w - r) return true;
    if (y > r && y < w - r) return true;
    const cx = x < r ? r : w - r;
    const cy = y < r ? r : w - r;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  const scanY = s * 0.5;
  const scanBand = s * 0.14;

  for (let py = 0; py < s; py++) {
    for (let px = 0; px < s; px++) {
      const idx = (py * s + px) * 4;
      if (!insideRounded(px, py)) {
        png.data[idx + 3] = 0;
        continue;
      }
      const g = py / s;
      let r = bgTop[0] + (bgBottom[0] - bgTop[0]) * g;
      let gg = bgTop[1] + (bgBottom[1] - bgTop[1]) * g;
      let b = bgTop[2] + (bgBottom[2] - bgTop[2]) * g;

      const gx = (px - s / 2) / (s / 2);
      const gy = (py - s * 0.45) / (s / 2);
      const glow = Math.max(0, 1 - Math.sqrt(gx * gx * 0.6 + gy * gy)) * 0.5;
      r += 30 * glow;
      gg += 60 * glow;
      b += 110 * glow;

      const mx = Math.floor((px - offset) / moduleSize);
      const my = Math.floor((py - offset) / moduleSize);
      if (mx >= 0 && my >= 0 && mx < GRID && my < GRID) {
        const gxm = mx - MARGIN;
        const gym = my - MARGIN;
        const on =
          gxm >= 0 && gym >= 0 && gxm < MODULES && gym < MODULES ? grid[gym][gxm] : false;
        if (on) {
          const fade = 1 - 0.18 * Math.min(1, Math.abs(gy) * 1.1);
          r = 235 * fade + r * (1 - fade);
          gg = 245 * fade + gg * (1 - fade);
          b = 255 * fade + b * (1 - fade);
        }
      }

      const d = Math.abs(py - scanY);
      if (d < scanBand) {
        const k = (1 - d / scanBand) ** 2 * 0.55;
        r += 20 * k;
        gg += 150 * k;
        b += 190 * k;
      }

      png.data[idx] = Math.min(255, Math.round(r));
      png.data[idx + 1] = Math.min(255, Math.round(gg));
      png.data[idx + 2] = Math.min(255, Math.round(b));
      png.data[idx + 3] = 255;
    }
  }

  return downsample(png, size);
}

/** Box-filter downsample from the supersampled buffer. */
function downsample(src, size) {
  const out = new PNG({ width: size, height: size });
  const k = SUPER;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < k; dy++) {
        for (let dx = 0; dx < k; dx++) {
          const i = ((y * k + dy) * src.width + (x * k + dx)) * 4;
          const alpha = src.data[i + 3] / 255;
          r += src.data[i] * alpha;
          g += src.data[i + 1] * alpha;
          b += src.data[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * size + x) * 4;
      const n = k * k;
      out.data[o] = a > 0 ? Math.round(r / a) : 0;
      out.data[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out.data[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out.data[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

mkdirSync(OUT_DIR, { recursive: true });

const jobs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}],
];

for (const [name, size, opts] of jobs) {
  writeFileSync(join(OUT_DIR, name), PNG.sync.write(render(size, opts)));
  console.log(`wrote public/icons/${name} (${size}x${size})`);
}
