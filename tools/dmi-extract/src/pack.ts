import { PNG } from 'pngjs';

/**
 * Shelf-pack: place each rect on the current shelf if it fits; otherwise
 * start a new shelf at `shelfY + shelfH`. Sufficient for our case (mostly
 * 32x32 cells, total <2k frames). We sort tallest-first so each shelf is
 * approximately the height of its tallest rect, which keeps wasted space low.
 */

export interface PackInput {
  /** Stable key — used as the atlas frame name. */
  key: string;
  width: number;
  height: number;
  /** Source pixel data (RGBA, length = width * height * 4). */
  pixels: Buffer;
}

export interface PackedFrame {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PackResult {
  png: PNG;
  frames: PackedFrame[];
}

const ATLAS_W = 2048;

export function packAtlas(inputs: PackInput[]): PackResult {
  // Tallest first; ties broken by widest first for deterministic output.
  const sorted = [...inputs].sort((a, b) => b.height - a.height || b.width - a.width);
  const frames: PackedFrame[] = [];
  let shelfX = 0;
  let shelfY = 0;
  let shelfH = 0;

  for (const it of sorted) {
    if (it.width > ATLAS_W) {
      throw new Error(`frame ${it.key} width ${it.width} > atlas width ${ATLAS_W}`);
    }
    if (shelfX + it.width > ATLAS_W) {
      shelfY += shelfH;
      shelfX = 0;
      shelfH = 0;
    }
    frames.push({ key: it.key, x: shelfX, y: shelfY, width: it.width, height: it.height });
    shelfX += it.width;
    if (it.height > shelfH) shelfH = it.height;
  }

  const atlasH = nextPow2(shelfY + shelfH);
  const png = new PNG({ width: ATLAS_W, height: atlasH });
  png.data.fill(0);

  // Blit each input by its key. Build a lookup since `frames` is sorted-stable
  // but `inputs` order is what owns the pixel data we want to copy.
  const byKey = new Map(inputs.map((i) => [i.key, i]));
  for (const f of frames) {
    const src = byKey.get(f.key);
    if (!src) continue;
    blit(png, src.pixels, src.width, src.height, f.x, f.y);
  }
  return { png, frames };
}

function blit(dst: PNG, srcPixels: Buffer, sw: number, sh: number, dx: number, dy: number): void {
  for (let y = 0; y < sh; y++) {
    const srcOff = y * sw * 4;
    const dstOff = ((dy + y) * dst.width + dx) * 4;
    srcPixels.copy(dst.data, dstOff, srcOff, srcOff + sw * 4);
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Slice an RGBA region out of a source PNG into a fresh Buffer. */
export function sliceRgba(
  src: PNG,
  sx: number,
  sy: number,
  width: number,
  height: number,
): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcOff = ((sy + y) * src.width + sx) * 4;
    const dstOff = y * width * 4;
    src.data.copy(out, dstOff, srcOff, srcOff + width * 4);
  }
  return out;
}
