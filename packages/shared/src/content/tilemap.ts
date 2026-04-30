/**
 * Pyrce tilemap JSON schema. Both client and server consume the same
 * artifact at `packages/shared/src/content/tilemap/default.json`.
 *
 *  - `grid` is `[y][x]` indexed; y=0 is the NORTH edge of the world.
 *  - `tileTypes[grid[y][x]]` gives the tile metadata at that cell.
 *  - Tiles outside the grid bounds are treated as void (impassable).
 */

export type TurfCategory = 'floor' | 'wall' | 'door' | 'void' | 'unknown';

export interface TileType {
  id: number;
  path: string;
  category: TurfCategory;
  passable: boolean;
}

export interface SpawnPoint {
  id: string;
  x: number;
  y: number;
}

export interface DoorPoint {
  kind: string;
  x: number;
  y: number;
}

export interface ContainerPoint {
  kind: string;
  x: number;
  y: number;
}

export interface VendingPoint {
  kind: string;
  x: number;
  y: number;
}

export interface WarpPoint {
  x: number;
  y: number;
  /** Warp tag — matching pairs share a tag. Stepping on one teleports
   *  to the OTHER warp with the same tag. */
  tag: string;
  /** True if this warp only sends (no incoming). */
  oneway: boolean;
}

export interface CameraPoint {
  x: number;
  y: number;
  tag: string;
}

export interface MonitorPoint {
  x: number;
  y: number;
}

export interface LightSwitchPoint {
  x: number;
  y: number;
  /** Tag matches the lights this switch controls. */
  tag: string;
}

export interface LightPoint {
  x: number;
  y: number;
  /** Tag matches a light switch's tag. */
  tag: string;
}

export interface FuseBoxPoint {
  x: number;
  y: number;
}

export interface TilemapJson {
  schemaVersion: 1;
  source: string;
  width: number;
  height: number;
  zLevel: number;
  tileTypes: TileType[];
  /** [y][x] -> index into tileTypes. */
  grid: number[][];
  spawns: SpawnPoint[];
  doors: DoorPoint[];
  containers: ContainerPoint[];
  /** Vending machines: spend yen for a soda. */
  vendings?: VendingPoint[];
  /** Warp tiles: vent drops, stair teleports, secret passages. */
  warps?: WarpPoint[];
  /** Security cameras placed in named areas. */
  cameras?: CameraPoint[];
  /** Security monitors that view a chosen camera. */
  monitors?: MonitorPoint[];
  /** Light switches: per-area light toggles. */
  lightSwitches?: LightSwitchPoint[];
  /** Light fixtures controlled by switches. */
  lights?: LightPoint[];
  /** Fuse box: cut power to many switches at once. */
  fuseBoxes?: FuseBoxPoint[];
}

/** Stable IDs for the seven directions we care about. */
export type Facing = 'N' | 'S' | 'E' | 'W' | 'NE' | 'NW' | 'SE' | 'SW';

export interface DeltaXY {
  dx: number;
  dy: number;
}

export const DIRECTION_DELTAS: Record<Facing, DeltaXY> = {
  N: { dx: 0, dy: -1 },
  S: { dx: 0, dy: 1 },
  E: { dx: 1, dy: 0 },
  W: { dx: -1, dy: 0 },
  NE: { dx: 1, dy: -1 },
  NW: { dx: -1, dy: -1 },
  SE: { dx: 1, dy: 1 },
  SW: { dx: -1, dy: 1 },
};
