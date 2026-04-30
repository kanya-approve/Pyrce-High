/**
 * CLI: convert a BYOND .dmm file into the Pyrce JSON tilemap format the
 * server + client both consume.
 *
 *   node dist/cli.js <input.dmm> <output.json> [--z 1]
 *
 * Only z=1 is emitted by default (the school floor). Other z-levels in
 * Default.dmm are unused for v1.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { objectsWithOverridesOf, parseDmm, turfOf } from './parse.js';
import {
  classifyTurf,
  objectIsCamera,
  objectIsContainer,
  objectIsDoor,
  objectIsFuseBox,
  objectIsLight,
  objectIsLightSwitch,
  objectIsMonitor,
  objectIsSpawn,
  objectIsVending,
  objectIsWarp,
  spawnIdOf,
  type TurfCategory,
} from './passability.js';

interface TileType {
  id: number;
  path: string;
  category: TurfCategory;
  passable: boolean;
}

interface SpawnPoint {
  id: string;
  x: number;
  y: number;
}
interface DoorPoint {
  kind: string;
  x: number;
  y: number;
}
interface ContainerPoint {
  kind: string;
  x: number;
  y: number;
}

interface VendingPoint {
  kind: string;
  x: number;
  y: number;
}

interface WarpPoint {
  x: number;
  y: number;
  /** Warp tag (matching pairs share a tag). */
  tag: string;
  /** True if this warp only sends (no incoming). */
  oneway: boolean;
}

interface CameraPoint {
  x: number;
  y: number;
  /** Tag identifies this camera in the security room. */
  tag: string;
}

interface MonitorPoint {
  x: number;
  y: number;
}

interface LightSwitchPoint {
  x: number;
  y: number;
  /** Tag groups which lights this switch toggles. */
  tag: string;
}

interface LightPoint {
  x: number;
  y: number;
  /** Tag matches a light switch's tag. */
  tag: string;
}

interface FuseBoxPoint {
  x: number;
  y: number;
}

interface TilemapJson {
  schemaVersion: 1;
  source: string;
  width: number;
  height: number;
  zLevel: number;
  tileTypes: TileType[];
  /** [y][x] -> index into tileTypes. y=0 is the NORTH edge. */
  grid: number[][];
  spawns: SpawnPoint[];
  doors: DoorPoint[];
  containers: ContainerPoint[];
  vendings: VendingPoint[];
  warps: WarpPoint[];
  cameras: CameraPoint[];
  monitors: MonitorPoint[];
  lightSwitches: LightSwitchPoint[];
  lights: LightPoint[];
  fuseBoxes: FuseBoxPoint[];
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error('usage: dm-to-tiled <input.dmm> <output.json> [--z N]');
    process.exit(2);
  }
  const inPath = resolve(argv[0] ?? '');
  const outPath = resolve(argv[1] ?? '');
  let zLevel = 1;
  const zIdx = argv.indexOf('--z');
  if (zIdx >= 0 && argv[zIdx + 1]) {
    zLevel = Number(argv[zIdx + 1]);
  }

  const source = readFileSync(inPath, 'utf8');
  const parsed = parseDmm(source);
  const block = parsed.blocks.find((b) => b.z === zLevel);
  if (!block) {
    console.error(
      `no grid block found for z=${zLevel}; available: ${parsed.blocks.map((b) => b.z).join(',')}`,
    );
    process.exit(3);
  }

  // Build tile-type registry.
  const tileTypeById = new Map<string, TileType>();
  const tileTypes: TileType[] = [];
  const indexFor = (path: string): number => {
    const existing = tileTypeById.get(path);
    if (existing) return existing.id;
    const cls = classifyTurf(path);
    const tt: TileType = {
      id: tileTypes.length,
      path,
      category: cls.category,
      passable: cls.passable,
    };
    tileTypeById.set(path, tt);
    tileTypes.push(tt);
    return tt.id;
  };

  const grid: number[][] = [];
  const spawns: SpawnPoint[] = [];
  const doors: DoorPoint[] = [];
  const containers: ContainerPoint[] = [];
  const vendings: VendingPoint[] = [];
  const warps: WarpPoint[] = [];
  const cameras: CameraPoint[] = [];
  const monitors: MonitorPoint[] = [];
  const lightSwitches: LightSwitchPoint[] = [];
  const lights: LightPoint[] = [];
  const fuseBoxes: FuseBoxPoint[] = [];

  for (let y = 0; y < block.height; y++) {
    const row = block.rows[y] ?? [];
    const gridRow: number[] = new Array(block.width);
    for (let x = 0; x < block.width; x++) {
      const key = row[x] ?? '';
      const entry = parsed.dict.get(key);
      if (!entry) {
        gridRow[x] = indexFor('/turf');
        continue;
      }
      const turf = turfOf(entry);
      gridRow[x] = indexFor(turf);
      // Walk the entry's objects for spawns / doors / containers / warps / etc.
      for (const { path, overrides } of objectsWithOverridesOf(entry)) {
        if (objectIsSpawn(path)) {
          const id = spawnIdOf(path);
          if (id) spawns.push({ id, x, y });
        } else if (objectIsDoor(path)) {
          doors.push({ kind: path, x, y });
        } else if (objectIsContainer(path)) {
          containers.push({ kind: path, x, y });
        } else if (objectIsVending(path)) {
          vendings.push({ kind: path, x, y });
        } else if (objectIsWarp(path)) {
          const tag = overrides.tag ?? '';
          if (tag) warps.push({ x, y, tag, oneway: overrides.oneway === '1' });
        } else if (objectIsCamera(path)) {
          const tag = overrides.tag ?? `camera-${cameras.length}`;
          cameras.push({ x, y, tag });
        } else if (objectIsMonitor(path)) {
          monitors.push({ x, y });
        } else if (objectIsLightSwitch(path)) {
          const tag = overrides.tag ?? `switch-${lightSwitches.length}`;
          lightSwitches.push({ x, y, tag });
        } else if (objectIsFuseBox(path)) {
          fuseBoxes.push({ x, y });
        } else if (objectIsLight(path)) {
          const tag = overrides.tag ?? `light-${lights.length}`;
          lights.push({ x, y, tag });
        }
      }
    }
    grid.push(gridRow);
  }

  const out: TilemapJson = {
    schemaVersion: 1,
    source: inPath.split('/').pop() ?? 'unknown.dmm',
    width: block.width,
    height: block.height,
    zLevel,
    tileTypes,
    grid,
    spawns,
    doors,
    containers,
    vendings,
    warps,
    cameras,
    monitors,
    lightSwitches,
    lights,
    fuseBoxes,
  };

  // Sanity: the spawns we expect (One..Twentytwo + Watcher + ShiniSpawn).
  const seen = new Set(spawns.map((s) => s.id));
  const expected = [
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
  ];
  const missing = expected.filter((e) => !seen.has(e));
  if (missing.length > 0) {
    console.warn(`WARN: missing ${missing.length} expected spawn(s): ${missing.join(', ')}`);
  }
  console.log(`spawns: ${spawns.length} (${expected.length} player + 2 special expected)`);
  console.log(`doors:  ${doors.length}`);
  console.log(`containers: ${containers.length}`);
  console.log(`warps: ${warps.length}`);
  console.log(`cameras: ${cameras.length}`);
  console.log(`monitors: ${monitors.length}`);
  console.log(
    `lightSwitches: ${lightSwitches.length}, lights: ${lights.length}, fuseBoxes: ${fuseBoxes.length}`,
  );
  console.log(`tile types: ${tileTypes.length}`);
  console.log(`grid: ${block.width} x ${block.height} at z=${zLevel}`);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out));
  const kb = (Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(1);
  console.log(`wrote ${outPath} (${kb} KB)`);
}

main();
