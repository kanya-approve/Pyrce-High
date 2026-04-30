import type { TilemapJson } from '@pyrce/shared';
// The build system inlines this JSON into the bundle via @rollup/plugin-json.
// Importing the .json directly keeps the artifact a single, regen-able blob;
// the type assertion narrows the loose JSON shape to our schema.
import rawTilemap from '../../../shared/src/content/tilemap/default.json' with { type: 'json' };

export const DEFAULT_TILEMAP = rawTilemap as TilemapJson;

/**
 * Server-authoritative tilemap helper. Wraps a `TilemapJson` with cached
 * lookups for the things the match handler needs every tick.
 */
export class Tilemap {
  readonly width: number;
  readonly height: number;
  /** Flat passability grid: idx = y * width + x. */
  private readonly passable: Uint8Array;
  /** Spawn points keyed by id (e.g. 'One', 'ShiniSpawn'). */
  readonly spawnsById: Map<string, { x: number; y: number }>;
  /** Numbered player spawns 1..22 in a stable order, for round-robin assignment. */
  readonly playerSpawns: Array<{ id: string; x: number; y: number }>;

  constructor(public readonly raw: TilemapJson) {
    this.width = raw.width;
    this.height = raw.height;
    this.passable = new Uint8Array(this.width * this.height);
    for (let y = 0; y < this.height; y++) {
      const row = raw.grid[y] ?? [];
      for (let x = 0; x < this.width; x++) {
        const idx = row[x] ?? -1;
        const tt = idx >= 0 ? raw.tileTypes[idx] : undefined;
        this.passable[y * this.width + x] = tt?.passable ? 1 : 0;
      }
    }

    this.spawnsById = new Map();
    for (const sp of raw.spawns) {
      this.spawnsById.set(sp.id, { x: sp.x, y: sp.y });
    }

    const numbered = ORDERED_SPAWN_IDS.map((id) => {
      const pt = this.spawnsById.get(id);
      return pt ? { id, x: pt.x, y: pt.y } : null;
    }).filter((s): s is { id: string; x: number; y: number } => s !== null);
    this.playerSpawns = numbered;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  isPassable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this.passable[y * this.width + x] === 1;
  }

  /** True if (x,y) is one of the door tiles in the source map. */
  isDoor(x: number, y: number): boolean {
    for (const d of this.raw.doors) if (d.x === x && d.y === y) return true;
    return false;
  }

  /** True if (x,y) is the Escape_Door (or adjacent to it within Chebyshev 1). */
  isAdjacentToEscapeDoor(x: number, y: number): boolean {
    for (const d of this.raw.doors) {
      if (d.kind !== '/obj/Escape_Door') continue;
      if (Math.max(Math.abs(d.x - x), Math.abs(d.y - y)) <= 1) return true;
    }
    return false;
  }

  /** True if (x,y) is on a Bathroom_Floor tile (proxy for "near a sink"). */
  isBathroomFloor(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const row = this.raw.grid[y] ?? [];
    const idx = row[x] ?? -1;
    if (idx < 0) return false;
    const tt = this.raw.tileTypes[idx];
    return tt?.path === '/turf/School_Floors/Bathroom_Floor';
  }

  /** Find the warp at (x,y), or null if none. */
  warpAt(x: number, y: number): { tag: string; oneway: boolean } | null {
    for (const w of this.raw.warps ?? []) {
      if (w.x === x && w.y === y) return { tag: w.tag, oneway: w.oneway };
    }
    return null;
  }

  /** Pick the destination warp for a tag — first matching warp that isn't (sx,sy). */
  warpDestination(tag: string, sx: number, sy: number): { x: number; y: number } | null {
    for (const w of this.raw.warps ?? []) {
      if (w.tag !== tag) continue;
      if (w.x === sx && w.y === sy) continue;
      // Skip oneway destinations — they only send.
      if (w.oneway) continue;
      return { x: w.x, y: w.y };
    }
    // Allow oneway-to-oneway sibling pairs (DM ventdrop/ventdrop2 style):
    // if the source is also oneway, fall through to the first non-self.
    for (const w of this.raw.warps ?? []) {
      if (w.tag !== tag) continue;
      if (w.x === sx && w.y === sy) continue;
      return { x: w.x, y: w.y };
    }
    return null;
  }

  /** Light switch at (x,y) and adjacency-check result for use. */
  lightSwitchAt(x: number, y: number): { tag: string; x: number; y: number } | null {
    for (const sw of this.raw.lightSwitches ?? []) {
      if (sw.x === x && sw.y === y) return { tag: sw.tag, x, y };
    }
    return null;
  }

  /** All light tiles for a given tag — used to compute the dark area. */
  lightsForTag(tag: string): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    for (const l of this.raw.lights ?? []) {
      if (l.tag === tag) out.push({ x: l.x, y: l.y });
    }
    return out;
  }

  /** Camera at (x,y), used for resolving Camera-View targets. */
  cameraByTag(tag: string): { x: number; y: number } | null {
    for (const c of this.raw.cameras ?? []) {
      if (c.tag === tag) return { x: c.x, y: c.y };
    }
    return null;
  }

  /** Monitor at (x,y) — used to gate camera/tape verbs. */
  monitorAt(x: number, y: number): boolean {
    for (const m of this.raw.monitors ?? []) {
      if (m.x === x && m.y === y) return true;
    }
    return false;
  }

  /** Adjacent monitor (Chebyshev ≤ 1). */
  isAdjacentToMonitor(x: number, y: number): boolean {
    for (const m of this.raw.monitors ?? []) {
      if (Math.max(Math.abs(m.x - x), Math.abs(m.y - y)) <= 1) return true;
    }
    return false;
  }

  /** Adjacent light switch (Chebyshev ≤ 1). */
  adjacentLightSwitch(x: number, y: number): { tag: string; x: number; y: number } | null {
    for (const sw of this.raw.lightSwitches ?? []) {
      if (Math.max(Math.abs(sw.x - x), Math.abs(sw.y - y)) <= 1) {
        return { tag: sw.tag, x: sw.x, y: sw.y };
      }
    }
    return null;
  }

  /** All cameras (read-only). */
  get cameras(): Array<{ x: number; y: number; tag: string }> {
    return this.raw.cameras ?? [];
  }
}

/**
 * The 22 player spawn ids in numbered order. We assign players to these in
 * sequence at game start; a 23rd+ player would error out of MAX_PLAYERS
 * before we run out of spawns.
 */
export const ORDERED_SPAWN_IDS: ReadonlyArray<string> = [
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
  'Twenty',
  'Twentyone',
  'Twentytwo',
] as const;

/** Singleton instance — only one map in v1. */
export const tilemap = new Tilemap(DEFAULT_TILEMAP);
