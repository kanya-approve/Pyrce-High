import { type Facing, ITEMS, type S2CClockTick, type TilemapJson } from '@pyrce/shared';
import { Scene } from 'phaser';
import type { ClientGameInfo } from '../../state/game';
import type { ClientInventory } from '../../state/inventory';

const TILE = 24;
/** Hard ambient floor at 6 PM (lightest) and midnight (darkest). */
const AMBIENT_AT_DUSK = 0.0; // 6 PM
const AMBIENT_AT_MIDNIGHT = 0.85;
const AMBIENT_AT_DAWN = 0.0; // 6 AM
/** Default light radius (in tiles) around the local player when nothing held. */
const DEFAULT_VISION_RADIUS = 5;
/** Flashlight cone half-angle in radians (~45° each side = 90° total). */
const FLASHLIGHT_HALF_ANGLE = Math.PI / 4;
/** Flashlight reach in tiles when held + on. */
const FLASHLIGHT_RANGE = 8;

/** Anything with x/y in world + tile coords. */
type Positioned = { x: number; y: number; tileX?: number; tileY?: number; facing?: Facing };

interface RemoteSpriteRef {
  userId: string;
  rect: Positioned;
}

interface LightingData {
  /** GameWorld passes in fns so Lighting can read its current state. */
  game: () => ClientGameInfo;
  inventory: () => ClientInventory;
  selfRect: () => Positioned | null;
  remotes: () => RemoteSpriteRef[];
  worldWidthPx: number;
  worldHeightPx: number;
  /** Tilemap for opacity raycasting (walls block light). */
  tilemap: TilemapJson;
}

/**
 * Tints the screen by in-game clock and cuts a soft radial hole for each
 * visible player based on their inventory's light-emitting items. Rendered
 * as a Phaser RenderTexture overlay rather than a per-tile lightmap so we
 * stay cheap and shader-free.
 */
export class Lighting extends Scene {
  private cfg!: LightingData;
  private overlay!: Phaser.GameObjects.RenderTexture;
  private brush!: Phaser.GameObjects.Graphics;
  /** Pre-baked opacity grid: 1 = blocks light, 0 = transparent. */
  private opacity!: Uint8Array;
  private gridW = 0;
  private gridH = 0;

  constructor() {
    super('Lighting');
  }

  init(data: LightingData): void {
    this.cfg = data;
    const t = data.tilemap;
    this.gridW = t.width;
    this.gridH = t.height;
    this.opacity = new Uint8Array(this.gridW * this.gridH);
    for (let y = 0; y < t.height; y++) {
      const row = t.grid[y] ?? [];
      for (let x = 0; x < t.width; x++) {
        const idx = row[x] ?? -1;
        const tt = idx >= 0 ? t.tileTypes[idx] : undefined;
        if (tt && (tt.category === 'wall' || tt.category === 'void')) {
          this.opacity[y * this.gridW + x] = 1;
        }
      }
    }
  }

  create(): void {
    const { width, height } = this.scale.gameSize;
    this.overlay = this.add
      .renderTexture(0, 0, width, height)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(900);
    this.brush = this.make.graphics({}, false);
  }

  override update(): void {
    const ambient = computeAmbient(this.cfg.game().clock);
    if (ambient <= 0.001) {
      this.overlay.setVisible(false);
      return;
    }
    this.overlay.setVisible(true);
    const { width, height } = this.scale.gameSize;
    this.overlay.clear();
    this.overlay.fill(0x000000, ambient, 0, 0, width, height);

    const cam = this.cameras.main;
    const sceneCamera = (this.scene.get('GameWorld') as Scene | undefined)?.cameras?.main;
    const offsetX = sceneCamera ? sceneCamera.scrollX : cam.scrollX;
    const offsetY = sceneCamera ? sceneCamera.scrollY : cam.scrollY;

    const inv = this.cfg.inventory();
    const radialRadius = computeLightRadius(inv);
    const flashlightOn = inv.items.some(
      (it) => it.itemId === 'flashlight' && it.data?.['on'] === true,
    );

    const self = this.cfg.selfRect();
    if (self) {
      this.cutLitTiles(self, radialRadius, offsetX, offsetY);
      if (flashlightOn && self.facing) {
        this.cutCone(self, FLASHLIGHT_RANGE, self.facing, offsetX, offsetY);
      }
    }
    for (const r of this.cfg.remotes()) {
      this.cutLitTiles(r.rect, 1.5, offsetX, offsetY);
    }
  }

  /**
   * Cut every lit tile within the radius from `origin`, sampling line-of-
   * sight against the opacity grid so walls block light. Falls back to a
   * single soft circle when origin lacks tile coords.
   */
  private cutLitTiles(
    origin: Positioned,
    radiusTiles: number,
    offsetX: number,
    offsetY: number,
  ): void {
    if (origin.tileX === undefined || origin.tileY === undefined) {
      this.cutSoftCircle(origin.x - offsetX, origin.y - offsetY, radiusTiles);
      return;
    }
    const ox = origin.tileX;
    const oy = origin.tileY;
    const r = Math.ceil(radiusTiles);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = ox + dx;
        const ty = oy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (dist > radiusTiles) continue;
        if (!this.lineOfSight(ox, oy, tx, ty)) continue;
        // Soft fade with distance.
        const alpha = 1 - dist / (radiusTiles + 1);
        const cx = tx * TILE + TILE / 2 - offsetX;
        const cy = ty * TILE + TILE / 2 - offsetY;
        this.brush.clear();
        this.brush.fillStyle(0xffffff, 0.35 * alpha + 0.4);
        this.brush.fillRect(-TILE / 2, -TILE / 2, TILE, TILE);
        this.overlay.erase(this.brush, cx, cy);
      }
    }
  }

  /** Bresenham line; returns false if any opaque tile sits between (excluding endpoints). */
  private lineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    let x = x0;
    let y = y0;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let steps = 0;
    while (true) {
      if (x === x1 && y === y1) return true;
      // Skip the origin tile; check intermediate tiles only.
      if (steps > 0 && this.isOpaque(x, y)) return false;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
      steps++;
      if (steps > 100) return false; // safety
    }
  }

  private isOpaque(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.gridW || y >= this.gridH) return true;
    return this.opacity[y * this.gridW + x] === 1;
  }

  /** Directional cone — flashlight. Sweeps a 90° wedge ahead of the player. */
  private cutCone(
    origin: Positioned,
    rangeTiles: number,
    facing: Facing,
    offsetX: number,
    offsetY: number,
  ): void {
    if (origin.tileX === undefined || origin.tileY === undefined) return;
    const dirAngle = facingToRadians(facing);
    const ox = origin.tileX;
    const oy = origin.tileY;
    const r = Math.ceil(rangeTiles);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx === 0 && dy === 0) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (dist > rangeTiles) continue;
        const angle = Math.atan2(dy, dx);
        let diff = angle - dirAngle;
        // Normalise to [-π, π].
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        if (Math.abs(diff) > FLASHLIGHT_HALF_ANGLE) continue;
        const tx = ox + dx;
        const ty = oy + dy;
        if (!this.lineOfSight(ox, oy, tx, ty)) continue;
        const alpha = 1 - dist / (rangeTiles + 1);
        const cx = tx * TILE + TILE / 2 - offsetX;
        const cy = ty * TILE + TILE / 2 - offsetY;
        this.brush.clear();
        this.brush.fillStyle(0xffffff, 0.45 * alpha + 0.4);
        this.brush.fillRect(-TILE / 2, -TILE / 2, TILE, TILE);
        this.overlay.erase(this.brush, cx, cy);
      }
    }
  }

  /** Fallback soft-circle cut for callers without tile coords (smoke fx etc). */
  private cutSoftCircle(cx: number, cy: number, radiusTiles: number): void {
    const outer = radiusTiles * TILE;
    const inner = Math.max(2, outer * 0.55);
    this.brush.clear();
    for (let i = 6; i >= 0; i--) {
      const t = i / 6;
      const rr = inner + (outer - inner) * t;
      const alpha = 0.18 * (1 - t) + 0.05;
      this.brush.fillStyle(0xffffff, alpha);
      this.brush.fillCircle(0, 0, rr);
    }
    this.overlay.erase(this.brush, cx, cy);
  }
}

function facingToRadians(f: Facing): number {
  // Screen coords: x → right, y → down. atan2(dy, dx).
  switch (f) {
    case 'E':
      return 0;
    case 'SE':
      return Math.PI / 4;
    case 'S':
      return Math.PI / 2;
    case 'SW':
      return (3 * Math.PI) / 4;
    case 'W':
      return Math.PI;
    case 'NW':
      return -(3 * Math.PI) / 4;
    case 'N':
      return -Math.PI / 2;
    case 'NE':
      return -Math.PI / 4;
    default:
      return Math.PI / 2;
  }
}

function computeAmbient(clock: S2CClockTick | null): number {
  if (!clock) return 0;
  // Convert to a 0..1 phase of the night where 0 = 6 PM, 0.5 = midnight,
  // 1.0 = 6 AM. We lerp ambient between dusk → midnight → dawn.
  const hour24 =
    clock.ampm === 'PM' ? clock.gameHour + 12 : clock.gameHour === 12 ? 0 : clock.gameHour;
  const minutesFromDusk = (((hour24 - 18 + 24) % 24) % 24) * 60;
  const phase = Math.min(1, Math.max(0, minutesFromDusk / (12 * 60)));
  if (phase <= 0.5) {
    const t = phase / 0.5;
    return AMBIENT_AT_DUSK * (1 - t) + AMBIENT_AT_MIDNIGHT * t;
  }
  const t = (phase - 0.5) / 0.5;
  return AMBIENT_AT_MIDNIGHT * (1 - t) + AMBIENT_AT_DAWN * t;
}

function computeLightRadius(inv: ClientInventory): number {
  let r = DEFAULT_VISION_RADIUS;
  for (const it of inv.items) {
    const def = ITEMS[it.itemId];
    if (def?.lightRadius) r = Math.max(r, def.lightRadius + 1);
  }
  return r;
}
