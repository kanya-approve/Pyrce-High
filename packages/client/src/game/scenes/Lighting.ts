import { ITEMS, type S2CClockTick } from '@pyrce/shared';
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

interface RemoteSpriteRef {
  userId: string;
  rect: Phaser.GameObjects.Rectangle;
}

interface LightingData {
  /** GameWorld passes in fns so Lighting can read its current state. */
  game: () => ClientGameInfo;
  inventory: () => ClientInventory;
  selfRect: () => Phaser.GameObjects.Rectangle | null;
  remotes: () => RemoteSpriteRef[];
  worldWidthPx: number;
  worldHeightPx: number;
}

/**
 * Tints the screen by in-game clock and cuts a soft radial hole for each
 * visible player based on their inventory's light-emitting items. The DM
 * source (`dynamic-lighting-simple.dmi`, `Light Source.dm`) inspired this;
 * we render it as a Phaser RenderTexture overlay rather than a per-tile
 * lightmap (cheap, no shader).
 */
export class Lighting extends Scene {
  private cfg!: LightingData;
  private overlay!: Phaser.GameObjects.RenderTexture;
  private brush!: Phaser.GameObjects.Graphics;

  constructor() {
    super('Lighting');
  }

  init(data: LightingData): void {
    this.cfg = data;
  }

  create(): void {
    const { width, height } = this.scale.gameSize;
    this.overlay = this.add
      .renderTexture(0, 0, width, height)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(900);

    // Brush is a soft radial gradient drawn off-screen, then "stamped" with
    // ERASE blend mode into the overlay each frame to cut light holes.
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
    const selfRadius = computeLightRadius(inv);

    const self = this.cfg.selfRect();
    if (self) this.cutHole(self.x - offsetX, self.y - offsetY, selfRadius);

    for (const r of this.cfg.remotes()) this.cutHole(r.rect.x - offsetX, r.rect.y - offsetY, 1.5);
  }

  private cutHole(cx: number, cy: number, radiusTiles: number): void {
    const outer = radiusTiles * TILE;
    const inner = Math.max(2, outer * 0.55);
    this.brush.clear();
    // Stack a few translucent circles to fake a smooth gradient — Graphics
    // doesn't expose radial gradients in Phaser 4 yet.
    for (let i = 6; i >= 0; i--) {
      const t = i / 6;
      const r = inner + (outer - inner) * t;
      const alpha = 0.18 * (1 - t) + 0.05;
      this.brush.fillStyle(0xffffff, alpha);
      this.brush.fillCircle(0, 0, r);
    }
    this.overlay.erase(this.brush, cx, cy);
  }
}

function computeAmbient(clock: S2CClockTick | null): number {
  if (!clock) return 0;
  // Convert to a 0..1 phase of the night where 0 = 6 PM, 0.5 = midnight,
  // 1.0 = 6 AM. We lerp ambient between dusk → midnight → dawn.
  const hour24 = clock.ampm === 'PM' ? clock.gameHour + 12 : clock.gameHour === 12 ? 0 : clock.gameHour;
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
