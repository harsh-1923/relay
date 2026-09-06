#!/usr/bin/env node
/**
 * Renders the desktop app icon straight to PNG bytes — the brand mark centred on a white plate.
 *
 * A traced reproduction of the brand mark in Figma — "Landing Page — Growth", node 76:17139 —
 * whose construction is two stacked layers of the same 40 radial bars, each shown through a
 * circular alpha mask. The red layer is masked to a centred disc, which is what cuts every bar
 * off on one shared circle; the pale layer sits on top under a smaller disc pushed to the left,
 * and where that disc covers a bar the bar reads pale instead of red. The boundary between the
 * two colours is therefore an off-centre circle, not a taper.
 *
 * Every dimension below is the Figma measurement divided by 63 — the radius of the red mask,
 * which is the mark's visible outer edge — so the numbers can be checked against the file.
 *
 * No SVG rasterizer is assumed to be on the machine, so this draws by evaluating a signed
 * distance field per pixel and encodes the PNG chunks (IHDR/IDAT/IEND) by hand, using only
 * `node:zlib` for the DEFLATE stream.
 *
 * Run: node resources/icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SIZE = 1024;
const SUPERSAMPLE = 4;

/**
 * The white plate the mark sits on.
 *
 * Apple's icon grid puts the shape in 824 of a 1024 canvas, leaving the margin every other Dock
 * icon carries; a full-bleed square reads as oversized beside them. The corner is a superellipse
 * rather than a circular round-rect, which is the shape macOS actually uses — at this size the
 * difference between the two is visible along the corner's flank.
 */
const PLATE_HALF = (824 / 1024) * (SIZE / 2);
const PLATE_EXPONENT = 5;
const PLATE = [255, 255, 255];

/** How much of the plate the mark takes up. The rest is the breathing room around it. */
const MARK_RADIUS = PLATE_HALF * 0.6;

/** One Figma unit, where 63 of them is the mark's outer radius. */
const U = MARK_RADIUS / 63;

// 24 spokes at 1.6x the traced stroke width, not the Figma source's 40 at 1x. Fewer, thicker
// bars hold together as an icon at Dock/menu-bar sizes; the source's count was tuned for a
// large illustration on a landing page, not a 16px glyph. Checked that neighbouring bars keep
// a real gap at BAR_INNER, the closest they ever get: pitch (15°) minus twice the half-width
// leaves ~4.1 of the 27.8 unit inner radius clear.
const SPOKE_COUNT = 24;
const BAR_INNER = 27.8333 * U;
/** The bars are drawn past the edge and cut by `CLIP_RADIUS`; that is how the source does it. */
const BAR_OUTER = 83.5 * U;
const BAR_HALF_WIDTH = 1.6 * U;
const CLIP_RADIUS = 63 * U;

/** The smaller disc, pushed left of centre, inside which a bar reads pale rather than red. */
const PALE_RADIUS = 47.5 * U;
const PALE_CENTER_X = -15 * U;
const PALE_CENTER_Y = 0;

// Traced as coral (#FF4242 / #FFD2D2) in Figma; swapped to near-black here — the red read as
// too faint against the title-bar and Dock chrome to work as an icon.
const RED = [26, 26, 26];
const PALE = [214, 214, 214];

/**
 * Whether a point is inside the plate: a superellipse, |x/a|^n + |y/a|^n <= 1.
 *
 * An inside test rather than a distance, because the caller only ever asks which side of the
 * edge a subsample falls on — the supersampling grid is what antialiases the corner, so the
 * true distance is never needed and the implicit form is exact where an approximation would not
 * be.
 */
function insidePlate(px, py) {
  const x = Math.abs(px) / PLATE_HALF;
  const y = Math.abs(py) / PLATE_HALF;
  return x ** PLATE_EXPONENT + y ** PLATE_EXPONENT <= 1;
}

/**
 * Distance from (px, py) to the rectangle spanning [a, b] with half-width `w` — square ends,
 * as an SVG stroke has by default.
 *
 * The point is taken into the bar's own frame, along the segment and across it, and then it is
 * an axis-aligned box: negative inside, and outside the corner term is the length of whichever
 * overshoots.
 */
function sdBox(px, py, ax, ay, bx, by, w) {
  const bax = bx - ax;
  const bay = by - ay;
  const length = Math.hypot(bax, bay);
  if (length === 0) return Infinity;
  const ux = bax / length;
  const uy = bay / length;

  const mx = px - (ax + bx) / 2;
  const my = py - (ay + by) / 2;
  const along = Math.abs(mx * ux + my * uy) - length / 2;
  const across = Math.abs(-mx * uy + my * ux) - w;

  return Math.min(Math.max(along, across), 0) + Math.hypot(Math.max(along, 0), Math.max(across, 0));
}

/** The first bar points straight up, and the rest step round by 360/40 = 9°, as in the source. */
const spokes = Array.from({ length: SPOKE_COUNT }, (_, i) => {
  const angle = -Math.PI / 2 + (i / SPOKE_COUNT) * Math.PI * 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    ax: cos * BAR_INNER,
    ay: sin * BAR_INNER,
    bx: cos * BAR_OUTER,
    by: sin * BAR_OUTER,
  };
});

/** The spoke whose centre angle is nearest a point, plus its neighbours — the gaps between
 *  spokes mean a pixel is never plausibly inside any spoke this doesn't include. */
function nearestSpokes(dx, dy) {
  const turns = (Math.atan2(dy, dx) + Math.PI / 2) / (Math.PI * 2);
  const base = Math.round(turns * SPOKE_COUNT + SPOKE_COUNT) % SPOKE_COUNT;
  return [(base - 1 + SPOKE_COUNT) % SPOKE_COUNT, base, (base + 1) % SPOKE_COUNT];
}

/**
 * Colour and coverage for one pixel, from a SUPERSAMPLE×SUPERSAMPLE grid.
 *
 * The colour is decided per subsample rather than once per pixel, so the pale/red boundary is
 * antialiased like every other edge. Two opaque colours meeting on a hard per-pixel test would
 * show a stepped seam across the middle of the mark.
 */
function samplePixel(x, y, half) {
  let hits = 0;
  let r = 0;
  let g = 0;
  let b = 0;

  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const dx = x + (sx + 0.5) / SUPERSAMPLE - half;
      const dy = y + (sy + 0.5) / SUPERSAMPLE - half;

      // Off the plate is off the icon. Everything else is opaque, so this edge is the only
      // thing alpha describes.
      if (!insidePlate(dx, dy)) continue;
      hits++;

      let color = PLATE;
      // The centred mask cuts every bar on one circle; combining it with the bar as a max is
      // the intersection of the two shapes.
      const clip = Math.hypot(dx, dy) - CLIP_RADIUS;
      if (clip <= 0) {
        for (const idx of nearestSpokes(dx, dy)) {
          const s = spokes[idx];
          if (Math.max(sdBox(dx, dy, s.ax, s.ay, s.bx, s.by, BAR_HALF_WIDTH), clip) <= 0) {
            color = Math.hypot(dx - PALE_CENTER_X, dy - PALE_CENTER_Y) <= PALE_RADIUS ? PALE : RED;
            break;
          }
        }
      }

      r += color[0];
      g += color[1];
      b += color[2];
    }
  }

  if (hits === 0) return null;
  const total = SUPERSAMPLE * SUPERSAMPLE;
  return [r / hits, g / hits, b / hits, hits / total];
}

function render() {
  const half = SIZE / 2;
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const sample = samplePixel(x, y, half);
      if (!sample) continue;
      const i = (y * SIZE + x) * 4;
      pixels[i] = Math.round(sample[0]);
      pixels[i + 1] = Math.round(sample[1]);
      pixels[i + 2] = Math.round(sample[2]);
      pixels[i + 3] = Math.round(sample[3] * 255);
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
