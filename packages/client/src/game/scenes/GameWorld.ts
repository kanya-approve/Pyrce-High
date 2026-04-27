import {
  type Facing,
  ITEMS,
  OpCode,
  type PublicGroundItem,
  type PublicPlayerInGame,
  type S2CContainerContents,
  type S2CCraftResult,
  type S2CInitialSnapshot,
  type S2CInvDelta,
  type S2CInvFull,
  type S2CPlayerMoved,
  type S2CWorldGroundItemDelta,
  type S2CWorldGroundItems,
  type TilemapJson,
} from '@pyrce/shared';
import tilemapData from '@pyrce/shared/src/content/tilemap/default.json' with { type: 'json' };
import { Scene } from 'phaser';
import type { NakamaMatchClient } from '../../net/matchClient';
import {
  applyDelta as applyInvDelta,
  applyFull as applyInvFull,
  type ClientInventory,
  newClientInventory,
} from '../../state/inventory';

const TILE = 24;
const MOVE_TWEEN_MS = 150;
const INPUT_THROTTLE_MS = 130;

interface GameWorldData {
  matchId: string;
  players: PublicPlayerInGame[];
  gameModeId: string | null;
}

interface PlayerSprite {
  userId: string;
  rect: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
  state: PublicPlayerInGame;
  tween?: Phaser.Tweens.Tween;
}

interface GroundSprite {
  groundItemId: string;
  data: PublicGroundItem;
  dot: Phaser.GameObjects.Arc;
}

export class GameWorld extends Scene {
  private match!: NakamaMatchClient;
  private matchId!: string;
  private map = tilemapData as TilemapJson;
  private players = new Map<string, PlayerSprite>();
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasdKeys!: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
  };
  private actionKeys!: {
    E: Phaser.Input.Keyboard.Key;
    G: Phaser.Input.Keyboard.Key;
    C: Phaser.Input.Keyboard.Key;
    I: Phaser.Input.Keyboard.Key;
    ONE: Phaser.Input.Keyboard.Key;
    TWO: Phaser.Input.Keyboard.Key;
    THREE: Phaser.Input.Keyboard.Key;
    FOUR: Phaser.Input.Keyboard.Key;
    FIVE: Phaser.Input.Keyboard.Key;
  };
  private lastInputAt = 0;
  private statusText?: Phaser.GameObjects.Text;
  private inventory: ClientInventory = newClientInventory();
  private groundSprites = new Map<string, GroundSprite>();
  private containerHotspots: Array<{
    id: string;
    x: number;
    y: number;
    rect: Phaser.GameObjects.Rectangle;
  }> = [];

  constructor() {
    super('GameWorld');
  }

  init(data: GameWorldData): void {
    this.matchId = data.matchId;
    this.players.clear();
    this.groundSprites.clear();
    this.inventory = newClientInventory();
    this.game.registry.set('gameWorld.players', data.players);
    this.game.registry.set('gameWorld.gameModeId', data.gameModeId);
  }

  create(): void {
    this.match = this.game.registry.get('match') as NakamaMatchClient;
    const initialPlayers =
      (this.game.registry.get('gameWorld.players') as PublicPlayerInGame[]) ?? [];

    this.buildMapTexture();
    this.add.image(0, 0, 'pyrce-map').setOrigin(0, 0);

    const worldW = this.map.width * TILE;
    const worldH = this.map.height * TILE;
    this.cameras.main.setBounds(0, 0, worldW, worldH);

    this.renderContainerHotspots();
    for (const p of initialPlayers) this.spawnPlayer(p);
    const me = this.players.get(this.match.userId);
    if (me) this.cameras.main.startFollow(me.rect, true, 0.1, 0.1);

    if (this.input.keyboard) {
      this.cursors = this.input.keyboard.createCursorKeys();
      this.wasdKeys = this.input.keyboard.addKeys('W,A,S,D') as typeof this.wasdKeys;
      this.actionKeys = this.input.keyboard.addKeys(
        'E,G,C,I,ONE,TWO,THREE,FOUR,FIVE',
      ) as typeof this.actionKeys;
      this.actionKeys.E.on('down', () => this.handleInteract());
      this.actionKeys.G.on('down', () => this.handleDropEquipped());
      this.actionKeys.C.on('down', () => this.handleCraft('spear'));
      this.actionKeys.I.on('down', () => this.scene.get('Hud').events.emit('inv:refresh'));
      this.actionKeys.ONE.on('down', () => this.handleHotkey(1));
      this.actionKeys.TWO.on('down', () => this.handleHotkey(2));
      this.actionKeys.THREE.on('down', () => this.handleHotkey(3));
      this.actionKeys.FOUR.on('down', () => this.handleHotkey(4));
      this.actionKeys.FIVE.on('down', () => this.handleHotkey(5));
    }

    this.statusText = this.add
      .text(12, 12, this.statusLine(), {
        fontFamily: 'Courier New',
        fontSize: 14,
        color: '#ffffff',
        backgroundColor: '#000000aa',
        padding: { left: 6, right: 6, top: 4, bottom: 4 },
      })
      .setScrollFactor(0)
      .setDepth(1000);

    // Persistent HUD overlay.
    this.scene.launch('Hud', { inventory: () => this.inventory });

    this.match.onMatchData((msg) => this.handleMatchData(msg.op_code, msg.data));
  }

  shutdown(): void {
    this.match.onMatchData(() => {});
    this.scene.stop('Hud');
  }

  override update(_time: number, _delta: number): void {
    const now = performance.now();
    if (now - this.lastInputAt < INPUT_THROTTLE_MS) return;
    const dir = this.readInputDirection();
    if (!dir) return;
    this.lastInputAt = now;
    void this.match.sendMatch(OpCode.C2S_MOVE_INTENT, { dir });
  }

  // ---------- input handlers ----------

  private handleInteract(): void {
    const me = this.players.get(this.match.userId)?.state;
    if (!me) return;
    // Pickup beats container open if both are at the player's tile.
    for (const g of this.groundSprites.values()) {
      if (g.data.x === me.x && g.data.y === me.y) {
        void this.match.sendMatch(OpCode.C2S_INV_PICKUP, { groundItemId: g.data.groundItemId });
        return;
      }
    }
    // Otherwise: open the nearest container within Chebyshev 1.
    let best: { x: number; y: number; dist: number } | null = null;
    for (const c of this.containerHotspots) {
      const dx = Math.abs(c.x - me.x);
      const dy = Math.abs(c.y - me.y);
      const d = Math.max(dx, dy);
      if (d > 1) continue;
      if (!best || d < best.dist) best = { x: c.x, y: c.y, dist: d };
    }
    if (best) {
      void this.match.sendMatch(OpCode.C2S_CONTAINER_LOOK, { x: best.x, y: best.y });
    }
  }

  private handleHotkey(slot: 1 | 2 | 3 | 4 | 5): void {
    const ref = this.inventory.hotkeys[slot - 1];
    if (!ref) return;
    void this.match.sendMatch(OpCode.C2S_INV_USE, { instanceId: ref });
  }

  private handleDropEquipped(): void {
    if (!this.inventory.equipped) return;
    void this.match.sendMatch(OpCode.C2S_INV_DROP, { instanceId: this.inventory.equipped });
  }

  private handleCraft(recipeId: string): void {
    void this.match.sendMatch(OpCode.C2S_INV_CRAFT, { recipeId });
  }

  // ---------- match-data dispatch ----------

  private handleMatchData(op: number, data: string | Uint8Array): void {
    switch (op) {
      case OpCode.S2C_PLAYER_MOVED: {
        const m = parsePayload<S2CPlayerMoved>(data);
        if (!m) return;
        const sprite = this.players.get(m.userId);
        if (!sprite) {
          this.spawnPlayer({
            userId: m.userId,
            username: m.userId,
            x: m.x,
            y: m.y,
            facing: m.facing,
          });
          return;
        }
        this.moveSprite(sprite, m.x, m.y, m.facing);
        break;
      }
      case OpCode.S2C_INITIAL_SNAPSHOT: {
        const snap = parsePayload<S2CInitialSnapshot>(data);
        if (!snap) return;
        this.reseedPlayers(snap.players);
        break;
      }
      case OpCode.S2C_INV_FULL: {
        const f = parsePayload<S2CInvFull>(data);
        if (!f) return;
        applyInvFull(this.inventory, f);
        this.notifyHud(`inventory: ${this.inventory.items.length} items`);
        break;
      }
      case OpCode.S2C_INV_DELTA: {
        const d = parsePayload<S2CInvDelta>(data);
        if (!d) return;
        applyInvDelta(this.inventory, d);
        this.notifyHud(d.upserted ? `+${d.upserted[0]?.itemId ?? 'item'}` : 'inv updated');
        break;
      }
      case OpCode.S2C_WORLD_GROUND_ITEMS: {
        const f = parsePayload<S2CWorldGroundItems>(data);
        if (!f) return;
        for (const g of this.groundSprites.values()) g.dot.destroy();
        this.groundSprites.clear();
        for (const g of f.items) this.spawnGround(g);
        break;
      }
      case OpCode.S2C_WORLD_GROUND_ITEM_DELTA: {
        const d = parsePayload<S2CWorldGroundItemDelta>(data);
        if (!d) return;
        if (d.removed) for (const id of d.removed) this.despawnGround(id);
        if (d.upserted) for (const g of d.upserted) this.spawnGround(g);
        break;
      }
      case OpCode.S2C_CONTAINER_CONTENTS: {
        const c = parsePayload<S2CContainerContents>(data);
        if (!c) return;
        // M3 quick UX: take everything we can fit, one at a time. A proper
        // modal lands later. Hit `E` again to take more.
        const top = c.container.contents[0];
        if (top) {
          this.notifyHud(
            `take ${ITEMS[top.itemId]?.name ?? top.itemId} from ${c.container.kind.split('/').pop()}`,
          );
          void this.match.sendMatch(OpCode.C2S_CONTAINER_TAKE, {
            containerId: c.container.containerId,
            instanceId: top.instanceId,
          });
        } else {
          this.notifyHud('container empty');
        }
        break;
      }
      case OpCode.S2C_CRAFT_RESULT: {
        const r = parsePayload<S2CCraftResult>(data);
        if (!r) return;
        this.notifyHud(r.ok ? `crafted ${r.recipeId}` : `craft failed: ${r.error}`);
        break;
      }
    }
    this.scene.get('Hud').events.emit('inv:refresh');
  }

  private notifyHud(msg: string): void {
    this.scene.get('Hud').events.emit('inv:notify', msg);
  }

  // ---------- rendering helpers ----------

  private statusLine(): string {
    const me = this.players.get(this.match.userId)?.state;
    const pos = me ? `(${me.x},${me.y}) facing ${me.facing}` : '(spectating)';
    return `pyrce ${this.matchId.slice(0, 8)} | ${this.match.username} ${pos} | players: ${this.players.size}`;
  }

  private readInputDirection(): Facing | null {
    if (!this.input.keyboard) return null;
    const up = this.cursors.up?.isDown || this.wasdKeys.W.isDown;
    const down = this.cursors.down?.isDown || this.wasdKeys.S.isDown;
    const left = this.cursors.left?.isDown || this.wasdKeys.A.isDown;
    const right = this.cursors.right?.isDown || this.wasdKeys.D.isDown;
    if (up && right) return 'NE';
    if (up && left) return 'NW';
    if (down && right) return 'SE';
    if (down && left) return 'SW';
    if (up) return 'N';
    if (down) return 'S';
    if (left) return 'W';
    if (right) return 'E';
    return null;
  }

  private spawnPlayer(p: PublicPlayerInGame): void {
    const x = p.x * TILE + TILE / 2;
    const y = p.y * TILE + TILE / 2;
    const isMe = p.userId === this.match.userId;
    const color = isMe ? 0x4cc8ff : 0xff7755;
    const rect = this.add.rectangle(x, y, TILE - 4, TILE - 4, color).setStrokeStyle(2, 0x000000);
    const label = this.add
      .text(x, y - TILE / 2 - 4, p.username, {
        fontFamily: 'Arial',
        fontSize: 11,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1);
    this.players.set(p.userId, { userId: p.userId, rect, label, state: p });
  }

  private despawnPlayer(userId: string): void {
    const sprite = this.players.get(userId);
    if (!sprite) return;
    sprite.tween?.stop();
    sprite.rect.destroy();
    sprite.label.destroy();
    this.players.delete(userId);
  }

  private moveSprite(sprite: PlayerSprite, x: number, y: number, facing: Facing): void {
    const targetX = x * TILE + TILE / 2;
    const targetY = y * TILE + TILE / 2;
    sprite.tween?.stop();
    sprite.tween = this.tweens.add({
      targets: [sprite.rect, sprite.label],
      x: () => targetX,
      y: (t: Phaser.GameObjects.GameObject) =>
        t === sprite.label ? targetY - TILE / 2 - 4 : targetY,
      duration: MOVE_TWEEN_MS,
      ease: 'Sine.easeInOut',
    });
    sprite.state = { ...sprite.state, x, y, facing };
    if (sprite.userId === this.match.userId && this.statusText) {
      this.statusText.setText(this.statusLine());
    }
  }

  private reseedPlayers(roster: PublicPlayerInGame[]): void {
    const seen = new Set<string>();
    for (const p of roster) {
      seen.add(p.userId);
      const existing = this.players.get(p.userId);
      if (existing) this.moveSprite(existing, p.x, p.y, p.facing);
      else this.spawnPlayer(p);
    }
    for (const id of Array.from(this.players.keys())) {
      if (!seen.has(id)) this.despawnPlayer(id);
    }
  }

  private spawnGround(g: PublicGroundItem): void {
    const existing = this.groundSprites.get(g.groundItemId);
    if (existing) {
      existing.dot.destroy();
      this.groundSprites.delete(g.groundItemId);
    }
    const cx = g.x * TILE + TILE / 2;
    const cy = g.y * TILE + TILE / 2;
    const dot = this.add.circle(cx, cy, 5, 0xffe066).setStrokeStyle(1, 0x000000).setDepth(2);
    this.groundSprites.set(g.groundItemId, { groundItemId: g.groundItemId, data: g, dot });
  }

  private despawnGround(id: string): void {
    const g = this.groundSprites.get(id);
    if (!g) return;
    g.dot.destroy();
    this.groundSprites.delete(id);
  }

  private renderContainerHotspots(): void {
    for (const c of this.map.containers) {
      const cx = c.x * TILE + TILE / 2;
      const cy = c.y * TILE + TILE / 2;
      const rect = this.add
        .rectangle(cx, cy, TILE - 8, TILE - 8, 0x886633, 0.55)
        .setStrokeStyle(1, 0xccaa66, 0.7)
        .setDepth(1);
      // Synthesise a stable id from coords. Server uses a randomised id;
      // the client identifies containers by coord here and the server
      // resolves the actual containerId on the look response. Until we
      // broadcast the manifest from the server, the smoke hits Look via
      // the closest container by coord (server validates proximity).
      const id = `c@${c.x},${c.y}`;
      this.containerHotspots.push({ id, x: c.x, y: c.y, rect });
    }
  }

  private buildMapTexture(): void {
    const w = this.map.width * TILE;
    const h = this.map.height * TILE;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < this.map.height; y++) {
      const row = this.map.grid[y] ?? [];
      for (let x = 0; x < this.map.width; x++) {
        const idx = row[x] ?? -1;
        const tt = idx >= 0 ? this.map.tileTypes[idx] : undefined;
        ctx.fillStyle = colourFor(tt?.category ?? 'void');
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
    if (this.textures.exists('pyrce-map')) this.textures.remove('pyrce-map');
    this.textures.addCanvas('pyrce-map', canvas);
  }
}

function colourFor(category: string): string {
  switch (category) {
    case 'floor':
      return '#3a3a48';
    case 'wall':
      return '#1a1a22';
    case 'door':
      return '#665533';
    case 'void':
      return '#000000';
    default:
      return '#222';
  }
}

function parsePayload<T>(data: string | Uint8Array): T | null {
  const raw = typeof data === 'string' ? data : new TextDecoder().decode(data);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
