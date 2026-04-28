import {
  ATLAS_KEY,
  BLOODY_ITEM_SPRITES,
  CHARACTER_SPRITES,
  CONTAINER_SPRITES,
  DOOR_SPRITES,
  type Facing,
  HAIR_OPTIONS_MALE,
  hairFrame,
  hairWalkFrames,
  ITEM_SPRITES,
  ITEMS,
  OpCode,
  type PublicCorpse,
  type PublicGroundItem,
  type PublicPlayerInGame,
  type S2CAnnouncement,
  type S2CClockTick,
  type S2CContainerContents,
  type S2CCorpseSpawn,
  type S2CCraftResult,
  type S2CDoorState,
  type S2CFxSmoke,
  type S2CFxSound,
  type S2CGameResult,
  type S2CInitialSnapshot,
  type S2CInvDelta,
  type S2CInvFull,
  type S2CPlayerDied,
  type S2CPlayerHealth,
  type S2CPlayerHP,
  type S2CPlayerMoved,
  type S2CPlayerStamina,
  type S2CProfileView,
  type S2CRoleAssigned,
  type S2CVoteEndGameTally,
  type S2CWorldGroundItemDelta,
  type S2CWorldGroundItems,
  type TilemapJson,
} from '@pyrce/shared';
import tilemapData from '@pyrce/shared/src/content/tilemap/default.json' with { type: 'json' };
import { Scene } from 'phaser';
import type { NakamaMatchClient } from '../../net/matchClient';
import { type ClientGameInfo, newClientGameInfo } from '../../state/game';
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
  hostUserId: string | null;
}

interface PlayerSprite {
  userId: string;
  rect: Phaser.GameObjects.Sprite;
  hair: Phaser.GameObjects.Sprite;
  hairId: string;
  hand?: Phaser.GameObjects.Image;
  outline: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
  hpBg: Phaser.GameObjects.Rectangle;
  hpFill: Phaser.GameObjects.Rectangle;
  crown?: Phaser.GameObjects.Image;
  state: PublicPlayerInGame;
  tween?: Phaser.Tweens.Tween;
}

interface GroundSprite {
  groundItemId: string;
  data: PublicGroundItem;
  dot: Phaser.GameObjects.Image | Phaser.GameObjects.Arc;
}

interface CorpseSprite {
  corpseId: string;
  data: PublicCorpse;
  rect: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
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
    F: Phaser.Input.Keyboard.Key;
    G: Phaser.Input.Keyboard.Key;
    C: Phaser.Input.Keyboard.Key;
    I: Phaser.Input.Keyboard.Key;
    V: Phaser.Input.Keyboard.Key;
    ONE: Phaser.Input.Keyboard.Key;
    TWO: Phaser.Input.Keyboard.Key;
    THREE: Phaser.Input.Keyboard.Key;
    FOUR: Phaser.Input.Keyboard.Key;
    FIVE: Phaser.Input.Keyboard.Key;
  };
  private lastInputAt = 0;
  private statusText?: Phaser.GameObjects.Text;
  private inventory: ClientInventory = newClientInventory();
  private gameInfo: ClientGameInfo = newClientGameInfo();
  private groundSprites = new Map<string, GroundSprite>();
  private containerHotspots: Array<{
    id: string;
    x: number;
    y: number;
    rect: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle;
  }> = [];
  private corpseSprites = new Map<string, CorpseSprite>();
  private deathOverlay?: Phaser.GameObjects.Rectangle;
  private hostUserId: string | null = null;

  constructor() {
    super('GameWorld');
  }

  init(data: GameWorldData): void {
    this.matchId = data.matchId;
    this.hostUserId = data.hostUserId ?? null;
    this.players.clear();
    this.groundSprites.clear();
    this.inventory = newClientInventory();
    this.gameInfo = newClientGameInfo();
    this.game.registry.set('gameWorld.players', data.players);
    this.game.registry.set('gameWorld.gameModeId', data.gameModeId);
  }

  create(): void {
    this.match = this.game.registry.get('match') as NakamaMatchClient;
    const initialPlayers =
      (this.game.registry.get('gameWorld.players') as PublicPlayerInGame[]) ?? [];

    this.registerCharacterAnims();
    this.buildMapTexture();
    this.add.image(0, 0, 'pyrce-map').setOrigin(0, 0);

    const worldW = this.map.width * TILE;
    const worldH = this.map.height * TILE;
    this.cameras.main.setBounds(0, 0, worldW, worldH);

    this.renderContainerHotspots();
    this.renderDoors();
    for (const p of initialPlayers) this.spawnPlayer(p);
    const me = this.players.get(this.match.userId);
    if (me) this.cameras.main.startFollow(me.rect, true, 0.1, 0.1);

    if (this.input.keyboard) {
      // enableCapture: false on every game-bound key — Phaser's keyboard
      // plugin captures keys at the document level and calls preventDefault
      // on them, which would stop our letters/numbers from reaching the
      // chat HTMLInputElement when it's focused. We poll isDown ourselves so
      // capture isn't needed. Arrows also disabled so chat-cursor navigation
      // and Tab/Enter behaviour aren't broken inside the input field.
      this.cursors = this.input.keyboard.addKeys(
        { up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', space: 'SPACE', shift: 'SHIFT' },
        false,
      ) as typeof this.cursors;
      this.wasdKeys = this.input.keyboard.addKeys('W,A,S,D', false) as typeof this.wasdKeys;
      this.actionKeys = this.input.keyboard.addKeys(
        'E,F,G,C,I,V,ONE,TWO,THREE,FOUR,FIVE',
        false,
      ) as typeof this.actionKeys;
      const guard = (fn: () => void) => () => {
        if (isTextInputFocused()) return;
        fn();
      };
      this.actionKeys.E.on(
        'down',
        guard(() => this.handleInteract()),
      );
      this.actionKeys.F.on(
        'down',
        guard(() => this.handleAttack()),
      );
      this.actionKeys.G.on(
        'down',
        guard(() => this.handleDropEquipped()),
      );
      this.actionKeys.C.on(
        'down',
        guard(() => this.handleCraft('spear')),
      );
      this.actionKeys.I.on(
        'down',
        guard(() => this.scene.get('Hud').events.emit('inv:refresh')),
      );
      this.actionKeys.V.on(
        'down',
        guard(() => this.handleEndGameVote()),
      );
      this.actionKeys.ONE.on(
        'down',
        guard(() => this.handleHotkey(1)),
      );
      this.actionKeys.TWO.on(
        'down',
        guard(() => this.handleHotkey(2)),
      );
      this.actionKeys.THREE.on(
        'down',
        guard(() => this.handleHotkey(3)),
      );
      this.actionKeys.FOUR.on(
        'down',
        guard(() => this.handleHotkey(4)),
      );
      this.actionKeys.FIVE.on(
        'down',
        guard(() => this.handleHotkey(5)),
      );
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

    // Persistent HUD overlay + chat overlay + lighting overlay.
    this.scene.launch('Hud', { inventory: () => this.inventory, game: () => this.gameInfo });
    this.scene.launch('ChatOverlay');
    this.scene.launch('Lighting', {
      game: () => this.gameInfo,
      inventory: () => this.inventory,
      selfRect: () => this.players.get(this.match.userId)?.rect ?? null,
      remotes: () =>
        Array.from(this.players.values())
          .filter((s) => s.userId !== this.match.userId && s.state.isAlive)
          .map((s) => ({ userId: s.userId, rect: s.rect })),
      worldWidthPx: this.map.width * TILE,
      worldHeightPx: this.map.height * TILE,
    });

    // Chat bubbles fired by the ChatOverlay scene.
    this.game.events.on(
      'chat:bubble',
      (ev: { userId: string; body: string; durationMs: number }) => {
        this.spawnChatBubble(ev.userId, ev.body, ev.durationMs);
      },
    );

    // Typing indicators — pop a "..." bubble while remote player is typing.
    this.game.events.on('chat:typing', (ev: { fromUserId: string; active: boolean }) => {
      this.setTypingIndicator(ev.fromUserId, ev.active);
    });

    this.match.onMatchData((msg) => this.handleMatchData(msg.op_code, msg.data));
  }

  shutdown(): void {
    this.match.onMatchData(() => {});
    this.game.events.off('chat:bubble');
    this.game.events.off('chat:typing');
    this.scene.stop('Hud');
    this.scene.stop('ChatOverlay');
    this.scene.stop('Lighting');
  }

  private typingBubbles = new Map<string, Phaser.GameObjects.Text>();

  private setTypingIndicator(userId: string, active: boolean): void {
    const sprite = this.players.get(userId);
    if (!sprite) return;
    const existing = this.typingBubbles.get(userId);
    if (active) {
      if (existing) return;
      const bubble = this.add
        .text(sprite.rect.x, sprite.rect.y - TILE - 4, '…', {
          fontFamily: 'Arial Black',
          fontSize: 16,
          color: '#ffffff',
          backgroundColor: '#00000099',
          padding: { left: 6, right: 6, top: 2, bottom: 0 },
        })
        .setOrigin(0.5, 1)
        .setDepth(1500);
      this.typingBubbles.set(userId, bubble);
      this.tweens.add({
        targets: bubble,
        alpha: { from: 0.4, to: 1 },
        duration: 600,
        yoyo: true,
        repeat: -1,
      });
    } else if (existing) {
      existing.destroy();
      this.typingBubbles.delete(userId);
    }
  }

  private spawnChatBubble(userId: string, body: string, durationMs: number): void {
    const sprite = this.players.get(userId);
    if (!sprite) return;
    const truncated = body.length > 80 ? `${body.slice(0, 77)}…` : body;
    const bubble = this.add
      .text(sprite.rect.x, sprite.rect.y - TILE - 4, truncated, {
        fontFamily: 'Arial',
        fontSize: 12,
        color: '#ffffff',
        backgroundColor: '#000000cc',
        padding: { left: 6, right: 6, top: 3, bottom: 3 },
        wordWrap: { width: 220 },
        align: 'center',
      })
      .setOrigin(0.5, 1)
      .setDepth(1200);
    // Follow sprite movement until destroyed.
    const follow = this.time.addEvent({
      delay: 50,
      loop: true,
      callback: () => {
        bubble.x = sprite.rect.x;
        bubble.y = sprite.rect.y - TILE - 4;
      },
    });
    this.tweens.add({
      targets: bubble,
      alpha: 0,
      delay: Math.max(0, durationMs - 500),
      duration: 500,
      onComplete: () => {
        follow.remove();
        bubble.destroy();
      },
    });
  }

  override update(_time: number, _delta: number): void {
    // Keep typing bubbles glued to their speaker every frame.
    for (const [userId, bubble] of this.typingBubbles) {
      const sprite = this.players.get(userId);
      if (!sprite) continue;
      bubble.setPosition(sprite.rect.x, sprite.rect.y - TILE - 4);
    }

    if (isTextInputFocused()) return; // chat / any text input owns the keys
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
    // Open or close the nearest adjacent door.
    let bestDoor: { x: number; y: number; dist: number } | null = null;
    for (const d of this.map.doors) {
      const dist = Math.max(Math.abs(d.x - me.x), Math.abs(d.y - me.y));
      if (dist > 1) continue;
      if (!bestDoor || dist < bestDoor.dist) bestDoor = { x: d.x, y: d.y, dist };
    }
    if (bestDoor) {
      void this.match.sendMatch(OpCode.C2S_DOOR_TOGGLE, { x: bestDoor.x, y: bestDoor.y });
      return;
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

  private handleAttack(): void {
    void this.match.sendMatch(OpCode.C2S_ATTACK, {});
  }

  /** Toggle our yes-vote on the in-round end-game referendum. */
  private endGameVotedYes = false;
  private handleEndGameVote(): void {
    this.endGameVotedYes = !this.endGameVotedYes;
    void this.match.sendMatch(OpCode.C2S_VOTE_END_GAME, { vote: this.endGameVotedYes });
    this.notifyHud(
      this.endGameVotedYes ? 'Voted to end the round (V to retract)' : 'Withdrew end-round vote',
    );
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
            hp: 100,
            maxHp: 100,
            isAlive: true,
            equippedItemId: m.equippedItemId,
            equippedItemBloody: m.equippedItemBloody,
          });
          return;
        }
        this.moveSprite(sprite, m.x, m.y, m.facing);
        this.updateEquippedSprite(sprite, m.equippedItemId, m.equippedItemBloody);
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
      case OpCode.S2C_PLAYER_HEALTH: {
        const h = parsePayload<S2CPlayerHealth>(data);
        if (!h) return;
        const s = this.players.get(h.userId);
        if (s) {
          s.state = { ...s.state, hp: h.hp, maxHp: h.maxHp, isAlive: h.isAlive };
          this.updateHpBar(s);
        }
        break;
      }
      case OpCode.S2C_PLAYER_HP: {
        const h = parsePayload<S2CPlayerHP>(data);
        if (!h) return;
        this.gameInfo.hp = h.hp;
        this.gameInfo.maxHp = h.maxHp;
        this.scene.get('Hud').events.emit('hud:vitals');
        break;
      }
      case OpCode.S2C_PLAYER_STAMINA: {
        const st = parsePayload<S2CPlayerStamina>(data);
        if (!st) return;
        this.gameInfo.stamina = st.stamina;
        this.gameInfo.maxStamina = st.maxStamina;
        this.scene.get('Hud').events.emit('hud:vitals');
        break;
      }
      case OpCode.S2C_PLAYER_DIED: {
        const d = parsePayload<S2CPlayerDied>(data);
        if (!d) return;
        const s = this.players.get(d.userId);
        if (s) {
          s.rect.setTint(0x666666);
          s.rect.setAlpha(0.55);
          s.label.setText(`†${s.state.username}`);
          this.updateHpBar(s);
        }
        if (d.userId === this.match.userId) this.showDeathOverlay(d);
        this.notifyHud(`${s?.state.username ?? d.userId.slice(0, 6)} died (${d.cause})`);
        break;
      }
      case OpCode.S2C_CORPSE_SPAWN: {
        const c = parsePayload<S2CCorpseSpawn>(data);
        if (!c) return;
        this.spawnCorpse(c.corpse);
        break;
      }
      case OpCode.S2C_ANNOUNCEMENT: {
        const a = parsePayload<S2CAnnouncement>(data);
        if (!a) return;
        this.flashAnnouncement(a);
        break;
      }
      case OpCode.S2C_FX_SMOKE: {
        const f = parsePayload<S2CFxSmoke>(data);
        if (!f) return;
        this.playSmoke(f.x * TILE + TILE / 2, f.y * TILE + TILE / 2);
        break;
      }
      case OpCode.S2C_FX_SOUND: {
        const f = parsePayload<S2CFxSound>(data);
        if (!f) return;
        this.playSfx(f.key, f.x, f.y, f.volume);
        break;
      }
      case OpCode.S2C_VOTE_END_GAME_TALLY: {
        const t = parsePayload<S2CVoteEndGameTally>(data);
        if (!t) return;
        this.notifyHud(`End-round vote: ${t.yes}/${t.alive} alive`);
        break;
      }
      case OpCode.S2C_PROFILE_VIEW: {
        const p = parsePayload<S2CProfileView>(data);
        if (!p) return;
        this.notifyHud(`${p.username}: ${p.condition} (${p.hp}/${p.maxHp})`);
        break;
      }
      case OpCode.S2C_DOOR_STATE: {
        const d = parsePayload<S2CDoorState>(data);
        if (!d) return;
        this.applyDoorState(d.x, d.y, d.open);
        break;
      }
      case OpCode.S2C_PLAYER_ROLE_ASSIGNED: {
        const r = parsePayload<S2CRoleAssigned>(data);
        if (!r) return;
        this.gameInfo.role = r;
        this.notifyHud(`You are: ${r.roleName}`);
        this.scene.get('Hud').events.emit('game:refresh');
        break;
      }
      case OpCode.S2C_CLOCK_TICK: {
        const c = parsePayload<S2CClockTick>(data);
        if (!c) return;
        this.gameInfo.clock = c;
        this.scene.get('Hud').events.emit('game:refresh');
        break;
      }
      case OpCode.S2C_GAME_RESULT: {
        const r = parsePayload<S2CGameResult>(data);
        if (!r) return;
        this.gameInfo.result = r;
        // Hand off to the EndScene; both GameWorld + Hud teardown.
        this.scene.start('EndScene', { result: r });
        this.scene.stop('Hud');
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

  /**
   * Register one walk animation per cardinal direction. Keys:
   * `male.walk.S`, `male.walk.N`, `male.walk.E`, `male.walk.W`.
   * Played on `S2C_PLAYER_MOVED`; we let it run through one cycle and
   * leave the sprite on the idle frame between steps.
   */
  private registerCharacterAnims(): void {
    if (this.anims.exists('male.walk.S')) return;
    const atlasTex = this.textures.get(ATLAS_KEY);
    for (const dir of ['S', 'N', 'E', 'W'] as const) {
      this.anims.create({
        key: `male.walk.${dir}`,
        frames: [0, 1, 2, 3].map((f) => ({
          key: ATLAS_KEY,
          frame: `hair-overlays/MaleBase/_/${dir}/${f}`,
        })),
        frameRate: 10,
        repeat: 0,
      });
      // One walk anim per (hair, dir). Skip hairs whose frames aren't packed
      // in the atlas (some male option names don't exist as DMIs).
      for (const hair of HAIR_OPTIONS_MALE) {
        const frames = hairWalkFrames(hair, dir).filter((k) => atlasTex.has(k));
        if (frames.length === 0) continue;
        this.anims.create({
          key: `hair.${hair}.walk.${dir}`,
          frames: frames.map((k) => ({ key: ATLAS_KEY, frame: k })),
          frameRate: 10,
          repeat: 0,
        });
      }
    }
  }

  /**
   * Play a positional SFX. Volume drops with Chebyshev distance from the
   * listener (self): full volume at 0 tiles, 0 at 14+. Sound out of range
   * is dropped entirely so we don't load the audio context with inaudible
   * .play() calls.
   */
  playSfx(key: string, worldTileX: number, worldTileY: number, baseVolume: number): void {
    if (!this.cache.audio.exists(key)) return;
    const me = this.players.get(this.match.userId)?.state;
    let attenuated = baseVolume;
    if (me) {
      const d = Math.max(Math.abs(me.x - worldTileX), Math.abs(me.y - worldTileY));
      const ATTENUATION_RANGE = 14;
      if (d >= ATTENUATION_RANGE) return;
      attenuated *= 1 - d / ATTENUATION_RANGE;
    }
    this.sound.play(key, { volume: Math.max(0, Math.min(1, attenuated)) });
  }

  /**
   * Play the smokey.dmi puff anim at world coords. Hooked to the smoke_bomb
   * use op when the server starts broadcasting it; for now exposed for any
   * client-side trigger.
   */
  playSmoke(worldX: number, worldY: number): void {
    if (!this.anims.exists('fx.smoke')) {
      const atlasTex = this.textures.get(ATLAS_KEY);
      const frames = [...Array(16).keys()]
        .map((i) => `root/smokey/_/S/${i}`)
        .filter((k) => atlasTex.has(k));
      if (frames.length === 0) return;
      this.anims.create({
        key: 'fx.smoke',
        frames: frames.map((k) => ({ key: ATLAS_KEY, frame: k })),
        frameRate: 12,
        repeat: 0,
      });
    }
    const fx = this.add.sprite(worldX, worldY, ATLAS_KEY).setDepth(900).setScale(2);
    fx.play('fx.smoke');
    fx.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => fx.destroy());
  }

  /**
   * Render (or update) a tiny in-hand sprite next to the player showing what
   * they're holding. Cosmetic only — the inventory state of remote players
   * is otherwise hidden.
   */
  private updateEquippedSprite(sprite: PlayerSprite, itemId: string | null, bloody = false): void {
    const atlasTex = this.textures.get(ATLAS_KEY);
    const bloodyFrame = bloody && itemId ? BLOODY_ITEM_SPRITES[itemId] : undefined;
    const normalFrame = itemId ? ITEM_SPRITES[itemId] : undefined;
    const frame = bloodyFrame && atlasTex.has(bloodyFrame) ? bloodyFrame : normalFrame;
    if (!frame || !atlasTex.has(frame)) {
      sprite.hand?.destroy();
      delete sprite.hand;
      return;
    }
    if (!sprite.hand) {
      sprite.hand = this.add
        .image(sprite.rect.x + TILE / 2 - 2, sprite.rect.y + 2, ATLAS_KEY, frame)
        .setScale(0.6)
        .setDepth(sprite.rect.depth + 0.015);
    } else {
      sprite.hand.setFrame(frame);
    }
  }

  /** Stable hair pick from userId so the same player looks the same each round. */
  private pickHair(userId: string): string {
    let h = 0;
    for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
    return HAIR_OPTIONS_MALE[h % HAIR_OPTIONS_MALE.length] ?? 'BlackBoyHair';
  }

  private spawnPlayer(p: PublicPlayerInGame): void {
    const x = p.x * TILE + TILE / 2;
    const y = p.y * TILE + TILE / 2;
    const isMe = p.userId === this.match.userId;
    // Friendly tint ring under the sprite — gives me-vs-others visual cue
    // until we have proper outlines / nameplates per faction.
    const ringColor = isMe ? 0x4cc8ff : 0xff7755;
    const outline = this.add.rectangle(x, y, TILE - 2, TILE - 2).setStrokeStyle(2, ringColor, 0.7);
    const cardinal = facingToCardinal(p.facing);
    const frame = CHARACTER_SPRITES.male[cardinal];
    const rect = this.add.sprite(x, y, ATLAS_KEY, frame);
    const hairId = this.pickHair(p.userId);
    const hairFr = hairFrame(hairId, cardinal);
    const atlasTex = this.textures.get(ATLAS_KEY);
    const hair = this.add
      .sprite(x, y, ATLAS_KEY, atlasTex.has(hairFr) ? hairFr : frame)
      .setDepth(rect.depth + 0.01);
    const label = this.add
      .text(x, y - TILE / 2 - 4, p.username, {
        fontFamily: 'Arial',
        fontSize: 11,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1);
    const hpBg = this.add
      .rectangle(x, y - TILE / 2 - 18, TILE - 4, 4, 0x330000)
      .setStrokeStyle(1, 0x000000)
      .setOrigin(0.5, 1);
    const hpFill = this.add
      .rectangle(x - (TILE - 4) / 2, y - TILE / 2 - 18, TILE - 4, 4, 0x55ff55)
      .setOrigin(0, 1);
    const sprite: PlayerSprite = {
      userId: p.userId,
      rect,
      hair,
      hairId,
      outline,
      label,
      hpBg,
      hpFill,
      state: p,
    };
    if (p.userId === this.hostUserId && atlasTex.has('root/crown/_/S/0')) {
      sprite.crown = this.add
        .image(x, y - TILE / 2 - 4, ATLAS_KEY, 'root/crown/_/S/0')
        .setDepth(rect.depth + 0.02);
    }
    this.players.set(p.userId, sprite);
    this.updateHpBar(sprite);
    if (p.equippedItemId) {
      this.updateEquippedSprite(sprite, p.equippedItemId, p.equippedItemBloody);
    }
    // Right-click to view profile (DM's `oview(7)` View_Profile verb).
    rect.setInteractive({ useHandCursor: true });
    rect.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown() || pointer.event.shiftKey) {
        if (p.userId !== this.match.userId) {
          void this.match.sendMatch(OpCode.C2S_VIEW_PROFILE, { userId: p.userId });
        }
      }
    });
  }

  private despawnPlayer(userId: string): void {
    const sprite = this.players.get(userId);
    if (!sprite) return;
    sprite.tween?.stop();
    sprite.rect.destroy();
    sprite.hair.destroy();
    sprite.hand?.destroy();
    sprite.crown?.destroy();
    sprite.outline.destroy();
    sprite.label.destroy();
    sprite.hpBg.destroy();
    sprite.hpFill.destroy();
    this.players.delete(userId);
  }

  private updateHpBar(s: PlayerSprite): void {
    const ratio = Math.max(0, Math.min(1, s.state.maxHp > 0 ? s.state.hp / s.state.maxHp : 0));
    const w = Math.max(0, (TILE - 4) * ratio);
    s.hpFill.setSize(w, 4);
    const colour = ratio > 0.66 ? 0x55ff55 : ratio > 0.33 ? 0xffcc44 : 0xff5555;
    s.hpFill.setFillStyle(colour);
    s.hpFill.setVisible(s.state.isAlive);
    s.hpBg.setVisible(s.state.isAlive);
  }

  private spawnCorpse(c: PublicCorpse): void {
    const existing = this.corpseSprites.get(c.corpseId);
    if (existing) {
      existing.rect.destroy();
      existing.label.destroy();
    }
    const x = c.x * TILE + TILE / 2;
    const y = c.y * TILE + TILE / 2;
    // BYOND draws corpses as the dead-state of the body sprite. Use the
    // base sprite tinted red so it reads as a body without per-character art.
    const rect: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle = this.textures
      .get(ATLAS_KEY)
      .has(CHARACTER_SPRITES.dead_male)
      ? this.add.image(x, y, ATLAS_KEY, CHARACTER_SPRITES.dead_male).setDepth(1.5).setTint(0xcc6666)
      : this.add
          .rectangle(x, y, TILE - 4, TILE - 4, 0x551111, 0.85)
          .setStrokeStyle(2, 0x880000)
          .setDepth(1.5);
    const tag = c.discovered ? `† ${c.victimRealName || c.victimUsername}` : '†';
    const label = this.add
      .text(x, y + TILE / 2 + 2, tag, {
        fontFamily: 'Arial',
        fontSize: 10,
        color: '#ffaaaa',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0)
      .setDepth(1.5);
    this.corpseSprites.set(c.corpseId, { corpseId: c.corpseId, data: c, rect, label });
  }

  private showDeathOverlay(d: S2CPlayerDied): void {
    const { width, height } = this.scale.gameSize;
    if (!this.deathOverlay) {
      this.deathOverlay = this.add
        .rectangle(0, 0, width, height, 0x000000, 0.55)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(2000);
      this.add
        .text(width / 2, height / 2, `You died — killed by ${d.cause}.\nSpectating…`, {
          fontFamily: 'Arial Black',
          fontSize: 32,
          color: '#ffffff',
          align: 'center',
        })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(2001);
    }
  }

  private flashAnnouncement(a: S2CAnnouncement): void {
    const { width } = this.scale.gameSize;
    const banner = this.add
      .text(width / 2, 56, a.message, {
        fontFamily: 'Arial Black',
        fontSize: 22,
        color: '#ff5555',
        backgroundColor: '#000000cc',
        padding: { left: 14, right: 14, top: 8, bottom: 8 },
        align: 'center',
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(1500);
    this.tweens.add({
      targets: banner,
      alpha: 0,
      delay: 4500,
      duration: 600,
      onComplete: () => banner.destroy(),
    });
  }

  private moveSprite(sprite: PlayerSprite, x: number, y: number, facing: Facing): void {
    const targetX = x * TILE + TILE / 2;
    const targetY = y * TILE + TILE / 2;
    sprite.tween?.stop();
    const cardinal = facingToCardinal(facing);
    sprite.rect.play(`male.walk.${cardinal}`, true);
    if (this.anims.exists(`hair.${sprite.hairId}.walk.${cardinal}`)) {
      sprite.hair.play(`hair.${sprite.hairId}.walk.${cardinal}`, true);
    }
    sprite.rect.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
      sprite.rect.setFrame(CHARACTER_SPRITES.male[cardinal]);
      sprite.hair.setFrame(hairFrame(sprite.hairId, cardinal));
    });
    const targets: Phaser.GameObjects.GameObject[] = [
      sprite.rect,
      sprite.hair,
      sprite.outline,
      sprite.label,
      sprite.hpBg,
      sprite.hpFill,
    ];
    if (sprite.crown) targets.push(sprite.crown);
    if (sprite.hand) targets.push(sprite.hand);
    sprite.tween = this.tweens.add({
      targets,
      x: (t: Phaser.GameObjects.GameObject) => {
        if (t === sprite.hpFill) return targetX - (TILE - 4) / 2;
        if (t === sprite.hand) return targetX + TILE / 2 - 2;
        return targetX;
      },
      y: (t: Phaser.GameObjects.GameObject) => {
        if (t === sprite.label) return targetY - TILE / 2 - 4;
        if (t === sprite.hpBg || t === sprite.hpFill) return targetY - TILE / 2 - 18;
        if (t === sprite.crown) return targetY - TILE / 2 - 4;
        if (t === sprite.hand) return targetY + 2;
        return targetY;
      },
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
    const frame = ITEM_SPRITES[g.itemId];
    const dot =
      frame && this.textures.get(ATLAS_KEY).has(frame)
        ? this.add.image(cx, cy, ATLAS_KEY, frame).setDepth(2)
        : this.add.circle(cx, cy, 5, 0xffe066).setStrokeStyle(1, 0x000000).setDepth(2);
    this.groundSprites.set(g.groundItemId, { groundItemId: g.groundItemId, data: g, dot });
  }

  private despawnGround(id: string): void {
    const g = this.groundSprites.get(id);
    if (!g) return;
    g.dot.destroy();
    this.groundSprites.delete(id);
  }

  private doorSprites = new Map<string, { sprite: Phaser.GameObjects.Image; kind: string }>();

  private renderDoors(): void {
    const atlasTex = this.textures.get(ATLAS_KEY);
    for (const d of this.map.doors) {
      const frame = DOOR_SPRITES[d.kind]?.closed;
      if (!frame || !atlasTex.has(frame)) continue;
      const sprite = this.add
        .image(d.x * TILE + TILE / 2, d.y * TILE + TILE / 2, ATLAS_KEY, frame)
        .setDepth(0.5);
      this.doorSprites.set(`${d.x},${d.y}`, { sprite, kind: d.kind });
    }
  }

  private applyDoorState(x: number, y: number, open: boolean): void {
    const entry = this.doorSprites.get(`${x},${y}`);
    if (!entry) return;
    const frames = DOOR_SPRITES[entry.kind];
    if (!frames) return;
    const target = open ? frames.open : frames.closed;
    if (this.textures.get(ATLAS_KEY).has(target)) entry.sprite.setFrame(target);
  }

  private renderContainerHotspots(): void {
    const atlasTex = this.textures.get(ATLAS_KEY);
    for (const c of this.map.containers) {
      const cx = c.x * TILE + TILE / 2;
      const cy = c.y * TILE + TILE / 2;
      const frame = CONTAINER_SPRITES[c.kind];
      const rect: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle =
        frame && atlasTex.has(frame)
          ? this.add.image(cx, cy, ATLAS_KEY, frame).setDepth(1)
          : this.add
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

    // Pull atlas image + per-tile-type frame lookup once.
    const atlasTex = this.textures.get(ATLAS_KEY);
    const atlasImg = atlasTex.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
    const turfIcons = (this.cache.json.get('turf-icons') ?? {}) as Record<string, string>;
    const frameByTileType: Array<Phaser.Textures.Frame | null> = this.map.tileTypes.map((tt) => {
      const key = turfIcons[tt.path];
      return key && atlasTex.has(key) ? atlasTex.get(key) : null;
    });

    for (let y = 0; y < this.map.height; y++) {
      const row = this.map.grid[y] ?? [];
      for (let x = 0; x < this.map.width; x++) {
        const idx = row[x] ?? -1;
        const tt = idx >= 0 ? this.map.tileTypes[idx] : undefined;
        const frame = idx >= 0 ? frameByTileType[idx] : null;
        if (frame) {
          // BYOND tiles are 32x32; our render TILE is 24. Scale on draw.
          ctx.drawImage(
            atlasImg,
            frame.cutX,
            frame.cutY,
            frame.cutWidth,
            frame.cutHeight,
            x * TILE,
            y * TILE,
            TILE,
            TILE,
          );
        } else {
          ctx.fillStyle = colourFor(tt?.category ?? 'void');
          ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
        }
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

function isTextInputFocused(): boolean {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = ae.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (ae as HTMLElement).isContentEditable === true;
}

function facingToCardinal(f: Facing): 'S' | 'N' | 'E' | 'W' {
  // Diagonals collapse to the dominant cardinal so we don't need 8-frame art.
  switch (f) {
    case 'N':
    case 'NE':
    case 'NW':
      return 'N';
    case 'S':
    case 'SE':
    case 'SW':
      return 'S';
    case 'E':
      return 'E';
    case 'W':
      return 'W';
    default:
      return 'S';
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
