import {
  type Facing,
  OpCode,
  type PublicPlayerInGame,
  type S2CInitialSnapshot,
  type S2CPlayerMoved,
  type TilemapJson,
} from '@pyrce/shared';
import tilemapData from '@pyrce/shared/src/content/tilemap/default.json' with { type: 'json' };
import { Scene } from 'phaser';
import type { NakamaMatchClient } from '../../net/matchClient';

const TILE = 24;
const MOVE_TWEEN_MS = 150;
/** Minimum delay between move intents we'll send. Below = dropped. */
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

/**
 * The actual playable scene. Renders the tilemap as a single canvas-backed
 * texture (cheap to draw once, fast to scroll), plus one rectangle per
 * player as a placeholder sprite. Real sprite atlases land in M7.
 */
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
  private lastInputAt = 0;
  private statusText?: Phaser.GameObjects.Text;

  constructor() {
    super('GameWorld');
  }

  init(data: GameWorldData): void {
    this.matchId = data.matchId;
    this.players.clear();
    // Stash the initial player roster on the registry so create() can use it
    // without re-typing the data through scene events.
    this.game.registry.set('gameWorld.players', data.players);
    this.game.registry.set('gameWorld.gameModeId', data.gameModeId);
  }

  create(): void {
    this.match = this.game.registry.get('match') as NakamaMatchClient;
    const initialPlayers =
      (this.game.registry.get('gameWorld.players') as PublicPlayerInGame[]) ?? [];

    this.buildMapTexture();
    this.add.image(0, 0, 'pyrce-map').setOrigin(0, 0);

    // World bounds + camera follow.
    const worldW = this.map.width * TILE;
    const worldH = this.map.height * TILE;
    this.cameras.main.setBounds(0, 0, worldW, worldH);
    this.physics?.world?.setBounds(0, 0, worldW, worldH);

    for (const p of initialPlayers) this.spawnPlayer(p);
    const me = this.players.get(this.match.userId);
    if (me) this.cameras.main.startFollow(me.rect, true, 0.1, 0.1);

    if (this.input.keyboard) {
      this.cursors = this.input.keyboard.createCursorKeys();
      this.wasdKeys = this.input.keyboard.addKeys('W,A,S,D') as typeof this.wasdKeys;
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

    this.match.onMatchData((msg) => this.handleMatchData(msg.op_code, msg.data));
  }

  shutdown(): void {
    this.match.onMatchData(() => {});
  }

  override update(_time: number, _delta: number): void {
    const now = performance.now();
    if (now - this.lastInputAt < INPUT_THROTTLE_MS) return;
    const dir = this.readInputDirection();
    if (!dir) return;
    this.lastInputAt = now;
    void this.match.sendMatch(OpCode.C2S_MOVE_INTENT, { dir });
  }

  // ---------- internals ----------

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
      x: (t: Phaser.GameObjects.GameObject) => (t === sprite.label ? targetX : targetX),
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

  private handleMatchData(op: number, data: string | Uint8Array): void {
    if (op === OpCode.S2C_PLAYER_MOVED) {
      const m = parsePayload<S2CPlayerMoved>(data);
      if (!m) return;
      const sprite = this.players.get(m.userId);
      if (!sprite) {
        // First time we're hearing about this player — spawn at their reported position.
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
    } else if (op === OpCode.S2C_INITIAL_SNAPSHOT) {
      const snap = parsePayload<S2CInitialSnapshot>(data);
      if (!snap) return;
      // Reseed: drop sprites we no longer know about; add/update the rest.
      const seen = new Set<string>();
      for (const p of snap.players) {
        seen.add(p.userId);
        const existing = this.players.get(p.userId);
        if (existing) this.moveSprite(existing, p.x, p.y, p.facing);
        else this.spawnPlayer(p);
      }
      for (const id of Array.from(this.players.keys())) {
        if (!seen.has(id)) this.despawnPlayer(id);
      }
    }
  }

  /**
   * Render the entire static tilemap into one DOM canvas, register as a
   * Phaser texture, and display as a single image. Avoids 10k-rectangle
   * scene overhead and gets free WebGL upload.
   */
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
