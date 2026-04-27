import { inflateSync } from 'node:zlib';
import { PNG } from 'pngjs';

/**
 * DMI is a standard PNG with a `zTXt` chunk (keyword "Description") whose
 * decompressed body is INI-flavoured BYOND state metadata. The image is a
 * row-major grid of `width * height` cells; each state consumes
 * `dirs * frames` cells (per BYOND: dir order S, N, E, W, SE, SW, NE, NW;
 * for an animation, all dirs of frame 1 come before any of frame 2).
 *
 * Exists in this repo only as a one-shot conversion path. Once the atlas is
 * frozen and committed, both this tool and the .dmi sources can be deleted.
 */

export interface DmiState {
  name: string;
  dirs: 1 | 4 | 8;
  frames: number;
  /** ms per frame, length === frames; absent when frames === 1. */
  delays?: number[];
  loop?: number;
  rewind?: boolean;
  movement?: boolean;
  hotspot?: { x: number; y: number; index: number };
}

export interface DmiHeader {
  version: string;
  width: number;
  height: number;
}

export interface ParsedDmi {
  header: DmiHeader;
  states: DmiState[];
  png: PNG;
  /** Filename minus .dmi, used to namespace state keys in the manifest. */
  sourceName: string;
}

/** Standard BYOND dir order for the cells of a single frame. */
export const DIR_ORDER: ReadonlyArray<'S' | 'N' | 'E' | 'W' | 'SE' | 'SW' | 'NE' | 'NW'> = [
  'S',
  'N',
  'E',
  'W',
  'SE',
  'SW',
  'NE',
  'NW',
];

export function parseDmi(buf: Buffer, sourceName: string): ParsedDmi {
  // Some BYOND DMIs have non-PNG trailing bytes (extra zTXt or junk) after
  // IEND that pngjs rejects with "unrecognised content at end of stream".
  // Trim to the first IEND chunk's CRC inclusive before handing to pngjs.
  const trimmed = trimToIend(buf);
  const png = PNG.sync.read(trimmed);
  const description = tryReadZtxtDescription(buf);
  let header: DmiHeader;
  let states: DmiState[];
  if (description !== null) {
    ({ header, states } = parseDescription(description));
  } else {
    // Fallback: a few .dmi files in the source repo are plain PNGs with no
    // BYOND zTXt chunk (they were used directly as overlays/HUD bitmaps).
    // Treat each as a single full-image frame so they still land in the atlas.
    header = { version: '4.0', width: png.width, height: png.height };
    states = [{ name: '', dirs: 1, frames: 1 }];
  }
  if (png.width % header.width !== 0 || png.height % header.height !== 0) {
    throw new Error(
      `${sourceName}: image ${png.width}x${png.height} not a multiple of cell ${header.width}x${header.height}`,
    );
  }
  return { header, states, png, sourceName };
}

function trimToIend(buf: Buffer): Buffer {
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    if (type === 'IEND') return buf.subarray(0, i + 8 + len + 4);
    i += 8 + len + 4;
  }
  return buf;
}

function tryReadZtxtDescription(buf: Buffer): string | null {
  let i = 8; // skip 8-byte PNG signature
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const body = buf.subarray(i + 8, i + 8 + len);
    if (type === 'zTXt') {
      const kwEnd = body.indexOf(0);
      const keyword = body.subarray(0, kwEnd).toString('latin1');
      if (keyword === 'Description') {
        const compressed = body.subarray(kwEnd + 2);
        return inflateSync(compressed).toString('latin1');
      }
    }
    if (type === 'IEND') break;
    i += 8 + len + 4;
  }
  return null;
}

function parseDescription(text: string): { header: DmiHeader; states: DmiState[] } {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let version = '';
  let width = 32;
  let height = 32;
  const states: DmiState[] = [];
  let cur: DmiState | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();

    if (key === 'state') {
      if (cur) states.push(cur);
      const name = val.replace(/^"|"$/g, '');
      cur = { name, dirs: 1, frames: 1 };
      continue;
    }
    if (!cur) {
      if (key === 'version') version = val;
      else if (key === 'width') width = Number(val);
      else if (key === 'height') height = Number(val);
      continue;
    }
    switch (key) {
      case 'dirs': {
        const n = Number(val);
        if (n === 1 || n === 4 || n === 8) cur.dirs = n;
        break;
      }
      case 'frames':
        cur.frames = Number(val);
        break;
      case 'delay':
        cur.delays = val.split(',').map((s) => Number(s.trim()));
        break;
      case 'loop':
        cur.loop = Number(val);
        break;
      case 'rewind':
        cur.rewind = val !== '0';
        break;
      case 'movement':
        cur.movement = val !== '0';
        break;
      case 'hotspot': {
        const parts = val.split(',').map((s) => Number(s.trim()));
        if (parts.length === 3 && parts.every((p) => !Number.isNaN(p))) {
          cur.hotspot = { x: parts[0]!, y: parts[1]!, index: parts[2]! };
        }
        break;
      }
    }
  }
  if (cur) states.push(cur);
  return { header: { version, width, height }, states };
}

/**
 * Yields one (state, dir, frame, srcRect) per cell in the DMI grid. Cells are
 * laid out row-major across all states in declaration order; per state the
 * order is `(frame * dirs + dir)` BYOND-style.
 */
export interface CellIter {
  stateName: string;
  dir: (typeof DIR_ORDER)[number];
  frame: number;
  sx: number;
  sy: number;
  width: number;
  height: number;
  /** Animation frame delay in ms (only when state.frames > 1). */
  delay?: number;
}

export function* iterCells(parsed: ParsedDmi): Generator<CellIter> {
  const { header, states, png } = parsed;
  const cellsPerRow = Math.floor(png.width / header.width);
  // BYOND allows duplicate state names within one DMI (distinguished by the
  // `movement` flag). Tag duplicates with @1, @2, … so packed keys stay unique.
  const seen = new Map<string, number>();
  let cellIndex = 0;
  for (const state of states) {
    const baseName = state.name;
    const n = seen.get(baseName) ?? 0;
    seen.set(baseName, n + 1);
    const tagged = n === 0 ? baseName : `${baseName}@${n}`;
    for (let f = 0; f < state.frames; f++) {
      for (let d = 0; d < state.dirs; d++) {
        const cx = cellIndex % cellsPerRow;
        const cy = Math.floor(cellIndex / cellsPerRow);
        const dir = DIR_ORDER[d]!;
        const cell: CellIter = {
          stateName: tagged,
          dir,
          frame: f,
          sx: cx * header.width,
          sy: cy * header.height,
          width: header.width,
          height: header.height,
        };
        const delay = state.delays?.[f];
        if (delay !== undefined) cell.delay = delay;
        yield cell;
        cellIndex++;
      }
    }
  }
}
