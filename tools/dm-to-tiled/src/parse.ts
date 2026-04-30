/**
 * Pure parser for BYOND `.dmm` map files.
 *
 * Format reference (observed from Pyrce High's `Default.dmm`; matches the
 * commonly-used DMM dialect documented by StrongDMM and friends):
 *
 *   1. A "dictionary" section: one entry per line, of the form
 *      `"KK" = (TYPE_PATH[, TYPE_PATH...])`
 *      where KK is a 2-char alphabetic key (mixed case) and each TYPE_PATH is
 *      either a bare `/...` path or `/path{key=val; key=val; ...}` with inline
 *      property overrides.
 *
 *   2. One or more grid blocks: each begins with `(x_start,y_start,z) = {"`
 *      on its own line, then N rows of (width × 2) characters where every
 *      consecutive 2-char pair is a dictionary key. Block ends with `"}` on
 *      its own line.
 *
 * Rendering note: BYOND grids run with y=1 at the SOUTH edge and y=world.maxy
 * at the NORTH edge. The grid rows in the file are stored TOP-DOWN (highest
 * y first). We invert during parse so the resulting `tiles[y][x]` array is
 * indexed with y=0 at the NORTH edge (matches Phaser/Tiled conventions).
 */

export interface DictEntry {
  /** The full type-path bundle for this tile, in source order. */
  paths: string[];
  /** Per-path inline `{...}` overrides, indexed by position in `paths`. */
  overrides: Array<Record<string, string> | null>;
}

export interface GridBlock {
  x: number;
  y: number;
  z: number;
  /** Rows of 2-char dictionary keys, **already inverted** to north-y-first. */
  rows: string[][];
  width: number;
  height: number;
}

export interface ParsedDmm {
  dict: Map<string, DictEntry>;
  blocks: GridBlock[];
}

const DICT_LINE = /^"([A-Za-z]{2})" = \((.*)\)$/;
const BLOCK_HEADER = /^\((\d+),(\d+),(\d+)\) = \{"$/;
const BLOCK_END = /^"\}$/;

export function parseDmm(source: string): ParsedDmm {
  const lines = source.split(/\r?\n/);
  const dict = new Map<string, DictEntry>();
  const blocks: GridBlock[] = [];

  let i = 0;
  // ---- Dictionary section ----
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line === '' || line.startsWith('//')) {
      i++;
      continue;
    }
    if (BLOCK_HEADER.test(line)) break;
    const m = DICT_LINE.exec(line);
    if (!m) {
      // Unrecognised line in dict section — skip silently. The DMM dialect
      // sometimes wraps long entries across lines; we don't see that in
      // Default.dmm so a strict parse is fine for now.
      i++;
      continue;
    }
    const [, key, body] = m;
    if (key && body !== undefined) {
      dict.set(key, parseDictBody(body));
    }
    i++;
  }

  // ---- Grid blocks ----
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const headerMatch = BLOCK_HEADER.exec(line);
    if (!headerMatch) {
      i++;
      continue;
    }
    const [, xs, ys, zs] = headerMatch;
    const xStart = Number(xs);
    const yStart = Number(ys);
    const zLevel = Number(zs);
    i++;

    const rawRows: string[] = [];
    while (i < lines.length && !BLOCK_END.test(lines[i] ?? '')) {
      rawRows.push(lines[i] ?? '');
      i++;
    }
    i++; // skip the closing "}"

    if (rawRows.length === 0) continue;
    const width = (rawRows[0] ?? '').length / 2;
    const rows: string[][] = [];
    // BYOND stores the file top-down (highest y first). Reverse so index 0
    // is the NORTH edge — matches Phaser tilemap conventions.
    for (let r = rawRows.length - 1; r >= 0; r--) {
      rows.push(splitRow(rawRows[r] ?? '', width));
    }
    blocks.push({
      x: xStart,
      y: yStart,
      z: zLevel,
      rows,
      width,
      height: rows.length,
    });
  }

  return { dict, blocks };
}

function splitRow(row: string, width: number): string[] {
  const out: string[] = new Array(width);
  for (let c = 0; c < width; c++) {
    out[c] = row.slice(c * 2, c * 2 + 2);
  }
  return out;
}

/**
 * Parse the body of a dict entry — the `(...)` between the key and EOL.
 * Splits on top-level commas (i.e. commas not inside `{...}` braces).
 */
function parseDictBody(body: string): DictEntry {
  const segments = splitTopLevel(body);
  const paths: string[] = [];
  const overrides: Array<Record<string, string> | null> = [];
  for (const seg of segments) {
    const braceStart = seg.indexOf('{');
    if (braceStart === -1) {
      paths.push(seg.trim());
      overrides.push(null);
      continue;
    }
    const path = seg.slice(0, braceStart).trim();
    const braceEnd = seg.lastIndexOf('}');
    const inner = braceEnd > braceStart ? seg.slice(braceStart + 1, braceEnd) : '';
    paths.push(path);
    overrides.push(parseOverrides(inner));
  }
  return { paths, overrides };
}

function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < body.length; k++) {
    const ch = body[k];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, k));
      start = k + 1;
    }
  }
  if (start < body.length) out.push(body.slice(start));
  return out;
}

function parseOverrides(inner: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Properties separated by `;`; values may contain quoted strings.
  // We only care about `tag` and `icon_state` for now — keep parsing simple.
  const parts = inner.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (k) result[k] = v;
  }
  return result;
}

/**
 * Find the turf path in a dict entry. By BYOND convention there is exactly
 * one /turf/ path per tile (others are /obj/ or /area/).
 */
export function turfOf(entry: DictEntry): string {
  for (const p of entry.paths) {
    if (p.startsWith('/turf')) return p;
  }
  return '/turf';
}

export function areaOf(entry: DictEntry): string {
  for (const p of entry.paths) {
    if (p.startsWith('/area')) return p;
  }
  return '/area';
}

export function objectsOf(entry: DictEntry): string[] {
  const out: string[] = [];
  for (const p of entry.paths) {
    if (p.startsWith('/obj')) out.push(p);
  }
  return out;
}

/** Same as `objectsOf` but pairs each /obj path with its inline override map. */
export function objectsWithOverridesOf(
  entry: DictEntry,
): Array<{ path: string; overrides: Record<string, string> }> {
  const out: Array<{ path: string; overrides: Record<string, string> }> = [];
  for (let i = 0; i < entry.paths.length; i++) {
    const p = entry.paths[i] ?? '';
    if (p.startsWith('/obj')) {
      out.push({ path: p, overrides: entry.overrides[i] ?? {} });
    }
  }
  return out;
}
