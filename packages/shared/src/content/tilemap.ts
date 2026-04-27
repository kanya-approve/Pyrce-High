/**
 * Pyrce tilemap JSON schema. Produced by `tools/dm-to-tiled` from a BYOND
 * `.dmm` source file. Both client and server consume the same artifact.
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
