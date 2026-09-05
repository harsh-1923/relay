#!/usr/bin/env node
/**
 * Renders the desktop app icon straight to PNG bytes — a ring of rounded radial bars fading
 * from pale pink to solid coral, like a spinner dial. No SVG rasterizer is assumed to be on
 * the machine, so this draws by evaluating a signed-distance field per pixel and encodes the
 * PNG chunks (IHDR/IDAT/IEND) by hand, using only `node:zlib` for the DEFLATE stream.
 *
 * Run: node resources/icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SIZE = 1024;
// macOS icons sit inset within their canvas — a full-bleed shape reads as oversized next to
// every other Dock icon, which all carry this same margin baked in.
const CONTENT_HALF = (SIZE / 2) * 0.8;
const SUPERSAMPLE = 4;
const CORAL = [240, 92, 84];

const BAR_COUNT = 32;
const OUTER_RADIUS = CONTENT_HALF;
const INNER_RADIUS = OUTER_RADIUS * 0.46;
const BAR_HALF_WIDTH = OUTER_RADIUS * 0.043;
/** Clock-angle (degrees, 0 = up, clockwise) of the palest bar. The seam — full coral dropping
 *  back to pale — sits one bar further counter-clockwise, matching a spinner's start point. */
const START_ANGLE = 15;
const ALPHA_MIN = 0.15;
const ALPHA_MAX = 1;

/** Point at `radius` along clock-angle `deg` (0 = up, clockwise), relative to the center. */
function clockPoint(deg, radius) {
  const rad = (deg * Math.PI) / 180;
  return [radius * Math.sin(rad), -radius * Math.cos(rad)];
}

/** Distance from (px, py) to the segment [a, b], minus `radius` — a capsule with round caps. */
function sdCapsule(px, py, ax, ay, bx, by, radius) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy) - radius;
}

const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
  const angle = START_ANGLE + (360 / BAR_COUNT) * i;
  const [ax, ay] = clockPoint(angle, INNER_RADIUS + BAR_HALF_WIDTH);
  const [bx, by] = clockPoint(angle, OUTER_RADIUS - BAR_HALF_WIDTH);
  const alpha = ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * (i / (BAR_COUNT - 1));
  return { ax, ay, bx, by, alpha };
});

/** Fraction of a 1x1 pixel cell covered by `sdf(x, y) <= 0`, via a SUPERSAMPLE×SUPERSAMPLE grid. */
function coverage(x, y, sdf) {
  let hits = 0;
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const px = x + (sx + 0.5) / SUPERSAMPLE;
      const py = y + (sy + 0.5) / SUPERSAMPLE;
      if (sdf(px, py) <= 0) hits++;
    }
  }
  return hits / (SUPERSAMPLE * SUPERSAMPLE);
}

/** The bar whose center angle is nearest a point, plus its neighbors — gaps between bars mean
 *  a pixel is never plausibly inside any bar this doesn't include. */
function nearestBars(dx, dy) {
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const raw = (((deg - START_ANGLE) / (360 / BAR_COUNT)) % BAR_COUNT) + BAR_COUNT;
  const base = Math.round(raw) % BAR_COUNT;
  return [(base - 1 + BAR_COUNT) % BAR_COUNT, base, (base + 1) % BAR_COUNT];
}

function render() {
  const half = SIZE / 2;
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const candidates = nearestBars(x - half, y - half);
      let bestCoverage = 0;
      let bestAlpha = 0;
      for (const idx of candidates) {
        const bar = bars[idx];
        const c = coverage(x, y, (px, py) =>
          sdCapsule(px - half, py - half, bar.ax, bar.ay, bar.bx, bar.by, BAR_HALF_WIDTH),
        );
        if (c > bestCoverage) {
          bestCoverage = c;
          bestAlpha = bar.alpha;
        }
      }

      const i = (y * SIZE + x) * 4;
      pixels[i] = CORAL[0];
      pixels[i + 1] = CORAL[1];
      pixels[i + 2] = CORAL[2];
      pixels[i + 3] = Math.round(bestCoverage * bestAlpha * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type: RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // per-scanline filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pixels = render();
const png = encodePng(pixels, SIZE);
const out = join(ROOT, 'icon.png');
writeFileSync(out, png);
console.log(`✓ wrote ${out} (${SIZE}×${SIZE})`);
