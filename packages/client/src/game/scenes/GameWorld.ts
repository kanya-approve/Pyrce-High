import {
  ATLAS_KEY,
  CHARACTER_SPRITES,
  CONTAINER_SPRITES,
  DIRECTION_DELTAS,
  DOOR_SPRITES,
  type Facing,
  HAIR_OPTIONS_FEMALE,
  HAIR_OPTIONS_MALE,
  hairFrame,
  hairWalkFrames,
  ITEM_SPRITES,
  ITEMS,
  OpCode,
  wieldedItemFrame,
  type PublicCorpse,
  type PublicGroundItem,
  type PublicPlayerInGame,
  type S2CAnnouncement,
  type S2CBloodDrip,
  type S2CCameraFeed,
  type S2CClockTick,
  type S2CContainerContents,
  type S2CContainerMoved,
  type S2CCorpseSpawn,
  type S2CCraftResult,
  type S2CDoorCode,
  type S2CDoorState,
  type S2CEyeOffer,
  type S2CFxButterfly,
  type S2CFxFeather,
  type S2CFxSmoke,
  type S2CFxSound,
  type S2CFxSwing,
  type S2CGameResult,
  type S2CGhostSense,
  type S2CInitialSnapshot,
  type S2CInvDelta,
  type S2CInvFull,
  type S2CLightState,
  type S2CPaperReceived,
  type S2CPaperText,
  type S2CPlayerDied,
  type S2CPlayerHealth,
  type S2CPlayerHP,
  type S2CPlayerMoved,
  type S2CPlayerStamina,
  type S2CPlayerStatus,
  type S2CProfileView,
  type S2CRoleAssigned,
  type S2CSearchDenied,
  type S2CSearchRequest,
  type S2CSelfRoleState,
  type S2CStudentRoster,
  type S2CTapeResult,
  type S2CVoteEndGameTally,
  type S2CVoteKickTally,
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
/** `Phaser.TintModes.FILL` — Phaser global isn't exposed in the ESM build. */
const TINT_FILL = 1;

// Server cooldown is MOVE_COOLDOWN_TICKS=1 tick @ 10Hz = 100ms between
// accepted moves. Match the tween to that so a held arrow flows continuously
// from one tile to the next without an idle pop-frame between steps.
const MOVE_TWEEN_MS = 110;
// Send a touch faster than the server cadence so the next intent is in the
// queue when the cooldown expires; the server silently drops extras.
const INPUT_THROTTLE_MS = 90;

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
  outline: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
  hpBg: Phaser.GameObjects.Rectangle;
  hpFill: Phaser.GameObjects.Rectangle;
  crown?: Phaser.GameObjects.Image;
  state: PublicPlayerInGame;
  tween?: Phaser.Tweens.Tween;
  /** Wielded-weapon underlay (DM's `underlays += knife.dmi`). */
  weapon?: Phaser.GameObjects.Image;
  equippedItemId?: string | null;
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
  private offMatchData: (() => void) | null = null;
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
    ENTER: Phaser.Input.Keyboard.Key;
    NUMPAD_FIVE: Phaser.Input.Keyboard.Key;
    CTRL: Phaser.Input.Keyboard.Key;
    ONE: Phaser.Input.Keyboard.Key;
    TWO: Phaser.Input.Keyboard.Key;
    THREE: Phaser.Input.Keyboard.Key;
    FOUR: Phaser.Input.Keyboard.Key;
    FIVE: Phaser.Input.Keyboard.Key;
  };
  private nameRevealActive = false;
  private sprintActive = false;
  private lastInputAt = 0;
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
  private lightsOff = new Set<string>();
  private bloodDrips: Phaser.GameObjects.GameObject[] = [];
  private cameraReturnTimer?: Phaser.Time.TimerEvent;

  constructor() {
    super('GameWorld');
  }

  init(data: GameWorldData): void {
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
    this.renderSpawnMarkers();
    this.renderInfrastructure();
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
      // Original DM keymap (Skinned.dmf macro section): WASD/arrows for
      // 8-direction movement, Shift to sprint, 1-5 for hotkey slots,
      // Enter for "Takethatthing" (pickup/interact), NumPad5 for PDA,
      // Ctrl held for see-names. Everything else is a right-click verb on
      // the relevant target — keeps the keyboard surface tiny.
      this.cursors = this.input.keyboard.addKeys(
        { up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', space: 'SPACE', shift: 'SHIFT' },
        false,
      ) as typeof this.cursors;
      this.wasdKeys = this.input.keyboard.addKeys('W,A,S,D', false) as typeof this.wasdKeys;
      this.actionKeys = this.input.keyboard.addKeys(
        'ENTER,NUMPAD_FIVE,CTRL,ONE,TWO,THREE,FOUR,FIVE',
        false,
      ) as typeof this.actionKeys;
      const guard = (fn: () => void) => () => {
        if (isTextInputFocused()) return;
        fn();
      };
      // Enter = "Takethatthing" — pickup item / open container / open
      // door / interact with whatever is at-or-adjacent in facing dir.
      this.actionKeys.ENTER.on(
        'down',
        guard(() => this.handleInteract()),
      );
      // NumPad5 = open the PDA inventory item if held.
      this.actionKeys.NUMPAD_FIVE.on(
        'down',
        guard(() => this.handleUsePda()),
      );
      // Ctrl held = name reveal toggle (see-names verb in DM).
      this.actionKeys.CTRL.on(
        'down',
        guard(() => this.toggleNameReveal(true)),
      );
      this.actionKeys.CTRL.on(
        'up',
        guard(() => this.toggleNameReveal(false)),
      );
      this.actionKeys.ONE.on('down', guard(() => this.handleHotkey(1)));
      this.actionKeys.TWO.on('down', guard(() => this.handleHotkey(2)));
      this.actionKeys.THREE.on('down', guard(() => this.handleHotkey(3)));
      this.actionKeys.FOUR.on('down', guard(() => this.handleHotkey(4)));
      this.actionKeys.FIVE.on('down', guard(() => this.handleHotkey(5)));
    }

    // Persistent HUD overlay + chat overlay + lighting overlay.
    this.scene.launch('Hud', { inventory: () => this.inventory, game: () => this.gameInfo });
    if (!this.scene.isActive('ChatOverlay')) this.scene.launch('ChatOverlay');
    // HUD slot button → fire the same handler as a 1-5 keypress.
    this.events.on('hud:hotkey', (slot: 1 | 2 | 3 | 4 | 5) => this.handleHotkey(slot));
    // Re-emit a refresh once the Hud's create() has had a chance to wire
    // its listeners. Without this, an S2C_ROLE_ASSIGNED that arrives in
    // the same tick as the Hud launch is missed and the role label stays
    // blank until the next clock tick.
    this.time.delayedCall(100, () => {
      this.scene.get('Hud').events.emit('game:refresh');
      this.scene.get('Hud').events.emit('inv:refresh');
    });

    // Right-click on empty world tile → open the global verb menu.
    // (Player sprites have their own pointerdown that fires earlier.)
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (!pointer.rightButtonDown()) return;
      const objs = this.input.hitTestPointer(pointer);
      if (objs.length > 0) return;
      const ev = pointer.event as MouseEvent;
      this.openWorldContextMenu(ev.clientX, ev.clientY);
    });
    // Suppress the browser's native right-click menu while playing. We
    // attach to document so it covers the canvas, the wrapper div, and
    // any DOM overlays we open ourselves.
    const suppressCtxMenu = (e: MouseEvent) => {
      // Allow the browser menu inside our own DOM popups (chat <input>
      // etc.) so users can paste / select.
      const tgt = e.target as HTMLElement | null;
      if (tgt && tgt.closest('input, textarea, .pyrce-allow-ctx')) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', suppressCtxMenu);
    this.events.once('shutdown', () => {
      document.removeEventListener('contextmenu', suppressCtxMenu);
    });
    this.scene.launch('Lighting', {
      game: () => this.gameInfo,
      inventory: () => this.inventory,
      selfRect: () => {
        const me = this.players.get(this.match.userId);
        if (!me) return null;
        return {
          x: me.rect.x,
          y: me.rect.y,
          tileX: me.state.x,
          tileY: me.state.y,
          facing: me.state.facing,
        };
      },
      remotes: () =>
        Array.from(this.players.values())
          .filter((s) => s.userId !== this.match.userId && s.state.isAlive)
          .map((s) => ({
            userId: s.userId,
            rect: {
              x: s.rect.x,
              y: s.rect.y,
              tileX: s.state.x,
              tileY: s.state.y,
              facing: s.state.facing,
            },
          })),
      worldWidthPx: this.map.width * TILE,
      worldHeightPx: this.map.height * TILE,
      tilemap: this.map,
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

    this.offMatchData = this.match.onMatchData((msg) =>
      this.handleMatchData(msg.op_code, msg.data),
    );

    // Background music: pick the mode-themed track. Falls back to the
    // default if the mode-specific track isn't loaded.
    this.startBackgroundMusic(this.game.registry.get('gameWorld.gameModeId') as string | null);
  }

  private bgm?: Phaser.Sound.BaseSound;
  private startBackgroundMusic(modeId: string | null): void {
    const candidates = [modeId ? `music.${modeId}` : null, 'music.normal'].filter(
      (k): k is string => k !== null,
    );
    for (const key of candidates) {
      if (this.cache.audio.exists(key)) {
        this.bgm = this.sound.add(key, { loop: true, volume: 0.3 });
        this.bgm.play();
        return;
      }
    }
  }

  shutdown(): void {
    this.bgm?.stop();
    this.offMatchData?.();
    this.offMatchData = null;
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
    // Sprint toggle: send on edge changes only.
    const wantSprint = !!this.cursors?.shift?.isDown;
    if (wantSprint !== this.sprintActive) {
      this.sprintActive = wantSprint;
      void this.match.sendMatch(OpCode.C2S_SPRINT_TOGGLE, { on: wantSprint });
    }
    const now = performance.now();
    const throttle = this.sprintActive ? INPUT_THROTTLE_MS / 2 : INPUT_THROTTLE_MS;
    if (now - this.lastInputAt < throttle) return;
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
    // Escape door beats regular door — if adjacent to /obj/Escape_Door,
    // try the escape verb (server checks Key Card + ends round).
    for (const d of this.map.doors) {
      if (d.kind !== '/obj/Escape_Door') continue;
      const dist = Math.max(Math.abs(d.x - me.x), Math.abs(d.y - me.y));
      if (dist <= 1) {
        void this.match.sendMatch(OpCode.C2S_ESCAPE_DOOR, {});
        return;
      }
    }
    // Open or close the nearest adjacent door.
    let bestDoor: { x: number; y: number; dist: number } | null = null;
    for (const d of this.map.doors) {
      if (d.kind === '/obj/Escape_Door') continue;
      const dist = Math.max(Math.abs(d.x - me.x), Math.abs(d.y - me.y));
      if (dist > 1) continue;
      if (!bestDoor || dist < bestDoor.dist) bestDoor = { x: d.x, y: d.y, dist };
    }
    if (bestDoor) {
      void this.match.sendMatch(OpCode.C2S_DOOR_TOGGLE, { x: bestDoor.x, y: bestDoor.y });
      return;
    }
    // Vending machine within range — buy a soda.
    let bestVend: { x: number; y: number; dist: number } | null = null;
    for (const v of this.map.vendings ?? []) {
      const dist = Math.max(Math.abs(v.x - me.x), Math.abs(v.y - me.y));
      if (dist > 1) continue;
      if (!bestVend || dist < bestVend.dist) bestVend = { x: v.x, y: v.y, dist };
    }
    if (bestVend) {
      void this.match.sendMatch(OpCode.C2S_VENDING_BUY, { x: bestVend.x, y: bestVend.y });
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

  private openVoteKickPicker(): void {
    this.openTargetPicker('Vote-kick a player', (targetUserId) => {
      void this.match.sendMatch(OpCode.C2S_VOTE_KICK, { targetUserId });
      this.notifyHud('Kick vote cast');
    });
  }

  /** Doppelganger: copy the nearest adjacent corpse's appearance. */
  private handleDoppelCopy(): void {
    const me = this.players.get(this.match.userId)?.state;
    if (!me) return;
    if (this.gameInfo.role?.roleId !== 'doppelganger') {
      this.notifyHud('Only the Doppelganger can copy corpses');
      return;
    }
    const target = this.nearestAdjacentCorpse(me.x, me.y);
    if (!target) {
      this.notifyHud('No adjacent corpse to copy');
      return;
    }
    void this.match.sendMatch(OpCode.C2S_DOPPELGANGER_COPY, { corpseId: target });
    this.notifyHud('Disguised as the body');
  }

  /** Vampire: drain blood from the nearest adjacent corpse for +30 HP. */
  private handleVampireDrain(): void {
    const me = this.players.get(this.match.userId)?.state;
    if (!me) return;
    if (this.gameInfo.role?.roleId !== 'vampire') {
      this.notifyHud('Only the Vampire can drain corpses');
      return;
    }
    const target = this.nearestAdjacentCorpse(me.x, me.y);
    if (!target) {
      this.notifyHud('No adjacent corpse to drain');
      return;
    }
    void this.match.sendMatch(OpCode.C2S_VAMPIRE_DRAIN, { corpseId: target });
  }

  /** School Computer roster modal: list of every player + condition. */
  private openStudentRoster(r: S2CStudentRoster): void {
    const parent = this.game.canvas.parentElement;
    if (!parent) return;
    const container = document.createElement('div');
    container.style.cssText =
      'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);min-width:340px;max-height:480px;overflow-y:auto;background:rgba(0,0,0,0.92);border:2px solid #88aaff;padding:14px;z-index:2300;color:#ffffff;font-family:Courier New,monospace;font-size:13px';
    const header = document.createElement('div');
    header.textContent = 'Student Roster (School Computer)';
    header.style.cssText = 'font-weight:bold;margin-bottom:10px;color:#ffd866';
    container.appendChild(header);
    // Group by classroom; entries without a classroom land in "Unassigned".
    const groups = new Map<string, typeof r.entries>();
    for (const e of r.entries) {
      const room = e.classroom ?? 'Unassigned';
      let g = groups.get(room);
      if (!g) {
        g = [];
        groups.set(room, g);
      }
      g.push(e);
    }
    const orderedRooms = [...groups.keys()].sort();
    for (const room of orderedRooms) {
      const roomHeader = document.createElement('div');
      roomHeader.textContent = `── Class ${room} ──`;
      roomHeader.style.cssText = 'margin-top:8px;color:#88aaff;font-weight:bold';
      container.appendChild(roomHeader);
      const list = groups.get(room) ?? [];
      for (const e of list) {
        const row = document.createElement('div');
        row.style.cssText =
          'padding:4px 0;border-bottom:1px solid #224;color:' + (e.isAlive ? '#dddddd' : '#aa6666');
        row.textContent = `${e.displayName.padEnd(28, ' ')} ${e.condition}`;
        container.appendChild(row);
      }
    }
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.style.cssText =
      'display:block;margin:10px auto 0;padding:6px 16px;cursor:pointer;background:#223344;color:#ffffff;border:1px solid #88aaff';
    close.addEventListener('click', () => container.remove());
    container.appendChild(close);
    parent.appendChild(container);
    setTimeout(() => container.parentElement && container.remove(), 30000);
  }

  /** Brief jab tween on the body when a weapon swings — replaces the old in-hand fx. */
  playSwingFx(userId: string): void {
    const sprite = this.players.get(userId);
    if (!sprite) return;
    this.tweens.add({
      targets: sprite.rect,
      scaleX: { from: 1, to: 1.15 },
      scaleY: { from: 1, to: 0.9 },
      duration: 70,
      yoyo: true,
    });
  }

  /** Purple-tinted echoes that fade in place — vampire dash. */
  spawnDashTrail(tileX: number, tileY: number): void {
    const wx = tileX * TILE + TILE / 2;
    const wy = tileY * TILE + TILE / 2;
    for (let i = 0; i < 4; i++) {
      const echo = this.add
        .image(wx, wy, ATLAS_KEY, CHARACTER_SPRITES.male.S)
        .setTint(0xaa55ff)
        .setAlpha(0.5 - i * 0.1)
        .setDepth(2);
      this.tweens.add({
        targets: echo,
        alpha: 0,
        duration: 400 + i * 80,
        onComplete: () => echo.destroy(),
      });
    }
  }

  /** Subtle dot on each spawn tile so map authors / spectators can see them. */
  private renderSpawnMarkers(): void {
    for (const sp of this.map.spawns) {
      this.add
        .circle(sp.x * TILE + TILE / 2, sp.y * TILE + TILE / 2, 3, 0xffd866, 0.35)
        .setDepth(0.4);
    }
  }

  /**
   * Drop on-tile sprites for cameras / monitors / light switches / lights so
   * players can see where they are. Each falls back to a labelled rectangle
   * if the atlas frame isn't loaded.
   */
  private switchSprites = new Map<string, Phaser.GameObjects.Image>();
  private renderInfrastructure(): void {
    const atlas = this.textures.get(ATLAS_KEY);
    const place = (
      x: number,
      y: number,
      frame: string,
      fallbackColor: number,
      label: string,
    ): Phaser.GameObjects.Image | null => {
      const cx = x * TILE + TILE / 2;
      const cy = y * TILE + TILE / 2;
      if (atlas.has(frame)) {
        return this.add.image(cx, cy, ATLAS_KEY, frame).setDepth(1).setAlpha(0.95);
      }
      this.add
        .rectangle(cx, cy, TILE - 8, TILE - 8, fallbackColor, 0.55)
        .setStrokeStyle(1, fallbackColor)
        .setDepth(1);
      this.add
        .text(cx, cy, label, {
          fontFamily: 'Arial',
          fontSize: 8,
          color: '#ffffff',
        })
        .setOrigin(0.5)
        .setDepth(1.01);
      return null;
    };
    for (const c of this.map.cameras ?? []) {
      place(c.x, c.y, 'mh-icons/placeables/camera/S/0', 0x4488cc, 'CAM');
    }
    for (const m of this.map.monitors ?? []) {
      place(m.x, m.y, 'mh-icons/placeables/monitor/S/0', 0x224488, 'MON');
    }
    for (const sw of this.map.lightSwitches ?? []) {
      const img = place(sw.x, sw.y, 'mh-icons/school/switch_on/S/0', 0xddcc44, 'SW');
      if (img) this.switchSprites.set(sw.tag, img);
    }
  }

  /** Swap each switch sprite based on whether its tag is in the off-set. */
  private refreshSwitchSprites(): void {
    const atlas = this.textures.get(ATLAS_KEY);
    const onFrame = 'mh-icons/school/switch_on/S/0';
    const offFrame = 'mh-icons/school/switch_off/S/0';
    for (const [tag, img] of this.switchSprites) {
      const target = this.lightsOff.has(tag) ? offFrame : onFrame;
      if (atlas.has(target)) img.setFrame(target);
    }
  }

  /** Paper modal: read-only view, write input, or airplane target picker. */
  private openPaperModal(p: S2CPaperText): void {
    const parent = this.game.canvas.parentElement;
    if (!parent) return;
    const container = document.createElement('div');
    container.style.cssText =
      'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);min-width:340px;background:rgba(0,0,0,0.92);border:2px solid #88aaff;padding:14px;z-index:2300;color:#ffffff;font-family:Courier New,monospace;font-size:13px';
    const header = document.createElement('div');
    header.textContent = 'Paper sheet';
    header.style.cssText = 'font-weight:bold;margin-bottom:8px;color:#ffd866';
    container.appendChild(header);
    const ta = document.createElement('textarea');
    ta.value = p.text;
    ta.style.cssText =
      'width:300px;height:120px;background:#111;color:#ffffff;border:1px solid #88aaff;padding:6px;font-family:Courier New,monospace;font-size:12px';
    ta.maxLength = 500;
    container.appendChild(ta);
    const row = document.createElement('div');
    row.style.cssText = 'margin-top:10px;display:flex;gap:6px;justify-content:flex-end';
    const save = document.createElement('button');
    save.textContent = 'Save';
    save.style.cssText =
      'padding:6px 14px;cursor:pointer;background:#225522;color:#aaffaa;border:1px solid #66aa66';
    save.addEventListener('click', () => {
      void this.match.sendMatch(OpCode.C2S_PAPER_WRITE, {
        instanceId: p.instanceId,
        text: ta.value,
      });
      container.remove();
    });
    const fly = document.createElement('button');
    fly.textContent = 'Send as Airplane';
    fly.style.cssText =
      'padding:6px 14px;cursor:pointer;background:#224488;color:#aaccff;border:1px solid #6699dd';
    fly.addEventListener('click', () => {
      // Save first so airplane carries the latest text.
      void this.match.sendMatch(OpCode.C2S_PAPER_WRITE, {
        instanceId: p.instanceId,
        text: ta.value,
      });
      container.remove();
      this.openTargetPicker('Airplane recipient', (targetUserId) => {
        void this.match.sendMatch(OpCode.C2S_PAPER_AIRPLANE, {
          instanceId: p.instanceId,
          targetUserId,
        });
      });
    });
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.style.cssText =
      'padding:6px 14px;cursor:pointer;background:#332222;color:#ffaaaa;border:1px solid #aa6666';
    close.addEventListener('click', () => container.remove());
    row.appendChild(save);
    row.appendChild(fly);
    row.appendChild(close);
    container.appendChild(row);
    parent.appendChild(container);
  }

  /** Black Feather projectile: a sprite that traverses the path tile-by-tile. */
  playFeather(path: Array<{ x: number; y: number }>): void {
    if (path.length === 0) return;
    const start = path[0];
    if (!start) return;
    const atlasTex = this.textures.get(ATLAS_KEY);
    const headFrame = 'mh-icons/windanimation/head/S/0';
    const bodyFrame = 'mh-icons/windanimation/body/S/0';
    const tailFrame = 'mh-icons/windanimation/tail/S/0';
    const haveDragon = atlasTex.has(headFrame) && atlasTex.has(bodyFrame);
    // Build a dragon: head leading the path, body segments trailing one
    // tile behind. Each tile, segments shift forward; the head fades on
    // impact.
    const tileCenter = (p: { x: number; y: number }) => ({
      x: p.x * TILE + TILE / 2,
      y: p.y * TILE + TILE / 2,
    });
    const head = this.add
      .image(
        tileCenter(start).x,
        tileCenter(start).y,
        ATLAS_KEY,
        haveDragon ? headFrame : (ITEM_SPRITES['black_feather'] ?? 0),
      )
      .setDepth(900);
    const body: Phaser.GameObjects.Image[] = [];
    let i = 1;
    const stepMs = 60;
    const advance = () => {
      if (i >= path.length) {
        // Tail boom
        this.tweens.add({
          targets: [head, ...body],
          alpha: 0,
          duration: 300,
          onComplete: () => {
            head.destroy();
            for (const b of body) b.destroy();
          },
        });
        return;
      }
      const next = path[i];
      if (!next) {
        head.destroy();
        for (const b of body) b.destroy();
        return;
      }
      const headPos = tileCenter(next);
      // Push a body segment at the head's previous position.
      if (haveDragon) {
        const seg = this.add
          .image(head.x, head.y, ATLAS_KEY, body.length === 0 ? bodyFrame : tailFrame)
          .setDepth(900);
        body.push(seg);
        // Cap trail to 4 segments; fade the oldest.
        if (body.length > 4) {
          const old = body.shift();
          if (old) {
            this.tweens.add({
              targets: old,
              alpha: 0,
              duration: 200,
              onComplete: () => old.destroy(),
            });
          }
        }
      }
      this.tweens.add({
        targets: head,
        x: headPos.x,
        y: headPos.y,
        duration: stepMs,
        onComplete: advance,
      });
      i++;
    };
    advance();
  }

  /** Killer's prompt to allow/deny a corpse search of a body they made. */
  private openSearchConsent(req: S2CSearchRequest): void {
    const parent = this.game.canvas.parentElement;
    if (!parent) return;
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.left = '50%';
    container.style.top = '50%';
    container.style.transform = 'translate(-50%, -50%)';
    container.style.minWidth = '320px';
    container.style.background = 'rgba(0,0,0,0.92)';
    container.style.border = '2px solid #ffd866';
    container.style.padding = '16px';
    container.style.zIndex = '2300';
    container.style.color = '#ffffff';
    container.style.fontFamily = 'Arial, sans-serif';
    container.style.fontSize = '14px';
    container.style.textAlign = 'center';
    container.innerHTML = `<div style="font-weight:bold;margin-bottom:10px">${req.searcherDisplayName} wants to search your victim's body.</div>`;
    const yes = document.createElement('button');
    yes.textContent = 'Allow';
    yes.style.cssText =
      'margin: 6px; padding: 8px 18px; cursor: pointer; background: #335533; color: #aaffaa; border: 1px solid #66aa66; font-size: 14px;';
    yes.addEventListener('click', () => {
      void this.match.sendMatch(OpCode.C2S_SEARCH_CONSENT, {
        requestId: req.requestId,
        accept: true,
      });
      container.remove();
    });
    const no = document.createElement('button');
    no.textContent = 'Deny';
    no.style.cssText =
      'margin: 6px; padding: 8px 18px; cursor: pointer; background: #553333; color: #ffaaaa; border: 1px solid #aa6666; font-size: 14px;';
    no.addEventListener('click', () => {
      void this.match.sendMatch(OpCode.C2S_SEARCH_CONSENT, {
        requestId: req.requestId,
        accept: false,
      });
      container.remove();
    });
    container.appendChild(yes);
    container.appendChild(no);
    parent.appendChild(container);
    // Auto-deny after 12s if no response.
    setTimeout(() => {
      if (container.parentElement) {
        void this.match.sendMatch(OpCode.C2S_SEARCH_CONSENT, {
          requestId: req.requestId,
          accept: false,
        });
        container.remove();
      }
    }, 12000);
  }

  /** Q: trigger the active mode's role ability (witch invisable, vampire dash). */
  private handleRoleAbility(): void {
    const role = this.gameInfo.role?.roleId;
    let ability: 'invisablewalk' | 'quickdash' | null = null;
    if (role === 'witch') ability = 'invisablewalk';
    else if (role === 'vampire' || role === 'nanaya') ability = 'quickdash';
    if (!ability) {
      this.notifyHud('No ability for this role');
      return;
    }
    void this.match.sendMatch(OpCode.C2S_ROLE_ABILITY, { ability });
  }

  /** P: pick up an adjacent corpse to drag, or drop the one you're carrying. */
  private pullingCorpseId: string | null = null;
  private handlePullCorpse(): void {
    if (this.pullingCorpseId !== null) {
      void this.match.sendMatch(OpCode.C2S_PULL_TOGGLE, { corpseId: null });
      this.pullingCorpseId = null;
      this.notifyHud('Dropped the body');
      return;
    }
    const me = this.players.get(this.match.userId)?.state;
    if (!me) return;
    const target = this.nearestAdjacentCorpse(me.x, me.y);
    if (!target) {
      this.notifyHud('No corpse to drag');
      return;
    }
    void this.match.sendMatch(OpCode.C2S_PULL_TOGGLE, { corpseId: target });
    this.pullingCorpseId = target;
    this.notifyHud('Dragging the body — P to drop');
  }

  private nearestAdjacentCorpse(x: number, y: number): string | null {
    let best: { id: string; dist: number } | null = null;
    for (const c of this.corpseSprites.values()) {
      const dist = Math.max(Math.abs(c.data.x - x), Math.abs(c.data.y - y));
      if (dist > 1) continue;
      if (!best || dist < best.dist) best = { id: c.corpseId, dist };
    }
    return best?.id ?? null;
  }

  private handleLightSwitch(): void {
    const me = this.players.get(this.match.userId)?.state;
    if (!me) return;
    let best: { tag: string; dist: number } | null = null;
    for (const sw of this.map.lightSwitches ?? []) {
      const dist = Math.max(Math.abs(sw.x - me.x), Math.abs(sw.y - me.y));
      if (dist > 1) continue;
      if (!best || dist < best.dist) best = { tag: sw.tag, dist };
    }
    if (!best) {
      this.notifyHud('No light switch adjacent');
      return;
    }
    void this.match.sendMatch(OpCode.C2S_LIGHT_SWITCH_TOGGLE, { tag: best.tag });
  }

  private cameraCycleIdx = 0;
  private handleCameraCycle(): void {
    const cams = this.map.cameras ?? [];
    if (cams.length === 0) {
      this.notifyHud('No cameras on this floor');
      return;
    }
    const cam = cams[this.cameraCycleIdx % cams.length];
    this.cameraCycleIdx++;
    if (!cam) return;
    void this.match.sendMatch(OpCode.C2S_CAMERA_VIEW, { tag: cam.tag });
    this.notifyHud(`Camera: ${cam.tag}`);
  }

  private handlePushContainer(): void {
    const me = this.players.get(this.match.userId)?.state;
    if (!me) return;
    const delta = DIRECTION_DELTAS[me.facing];
    if (!delta) return;
    const tx = me.x + delta.dx;
    const ty = me.y + delta.dy;
    const target = this.containerHotspots.find((c) => c.x === tx && c.y === ty);
    if (!target) {
      this.notifyHud('Nothing to push in front of you');
      return;
    }
    this.pushContainerAwayFromMe(target.x, target.y);
  }

  /**
   * Push a specific container away from the player. Re-orients the player
   * to face it first so the server's facing-direction push lands the
   * container on the far side. The container must be cardinal-adjacent
   * (no diagonals — push only operates on N/S/E/W neighbours).
   */
  private pushContainerAwayFromMe(cx: number, cy: number): void {
    const me = this.players.get(this.match.userId)?.state;
    if (!me) return;
    const dx = cx - me.x;
    const dy = cy - me.y;
    let dir: Facing | null = null;
    if (dx === 0 && dy === -1) dir = 'N';
    else if (dx === 0 && dy === 1) dir = 'S';
    else if (dx === -1 && dy === 0) dir = 'W';
    else if (dx === 1 && dy === 0) dir = 'E';
    if (!dir) {
      this.notifyHud('Move next to it (no diagonals)');
      return;
    }
    // Update local facing immediately so the server-side check passes
    // even if our last MOVE_INTENT was in another direction. The server
    // sets `player.facing = req.dir` on every move intent (even blocked),
    // so a blocked move toward the container is enough to align.
    void this.match.sendMatch(OpCode.C2S_MOVE_INTENT, { dir });
    // Tiny nudge to let the facing land before the push.
    this.time.delayedCall(40, () => {
      void this.match.sendMatch(OpCode.C2S_CONTAINER_PUSH, { x: cx, y: cy });
    });
  }

  /**
   * Right-click on a container → menu with Search / Push (if movable).
   * Targets the specific container clicked, not the one in front.
   */
  private openContainerContextMenu(
    cx: number,
    cy: number,
    stationed: boolean,
    screenX: number,
    screenY: number,
  ): void {
    const me = this.players.get(this.match.userId)?.state;
    const dist = me ? Math.max(Math.abs(me.x - cx), Math.abs(me.y - cy)) : 99;
    const verbs: Array<{ label: string; run: () => void }> = [];
    if (dist <= 1) {
      verbs.push({
        label: 'Search',
        run: () => void this.match.sendMatch(OpCode.C2S_CONTAINER_LOOK, { x: cx, y: cy }),
      });
      if (!stationed) {
        verbs.push({ label: 'Push (away)', run: () => this.pushContainerAwayFromMe(cx, cy) });
      }
    } else {
      verbs.push({ label: '(walk closer)', run: () => {} });
    }
    this.renderContextMenu(`Container @ ${cx},${cy}`, verbs, screenX, screenY);
  }

  private handlePushCorpse(): void {
    const me = this.players.get(this.match.userId)?.state;
    if (!me) return;
    // Push the corpse directly in front of the player so the server's
    // facing-direction push moves it away, not toward us.
    const delta = DIRECTION_DELTAS[me.facing];
    if (!delta) return;
    const tx = me.x + delta.dx;
    const ty = me.y + delta.dy;
    const target = Array.from(this.corpseSprites.values()).find(
      (c) => c.data.x === tx && c.data.y === ty,
    );
    if (!target) {
      this.notifyHud('No corpse in front of you');
      return;
    }
    void this.match.sendMatch(OpCode.C2S_CORPSE_PUSH, { corpseId: target.corpseId });
  }

  /**
   * Plant an inventory item into an adjacent corpse or KO'd player. Picks
   * the equipped item by default; opens a one-shot prompt if no equipped
   * item is held.
   */
  private handlePlantOnTarget(): void {
    const me = this.players.get(this.match.userId)?.state;
    if (!me) return;
    const corpseId = this.nearestAdjacentCorpse(me.x, me.y);
    let target: { kind: 'corpse'; corpseId: string } | { kind: 'player'; userId: string } | null =
      null;
    if (corpseId) {
      target = { kind: 'corpse', corpseId };
    } else {
      // KO'd / dead-but-not-corpsed adjacent player.
      for (const sprite of this.players.values()) {
        const p = sprite.state;
        if (!p || p.userId === this.match.userId) continue;
        const dist = Math.max(Math.abs(p.x - me.x), Math.abs(p.y - me.y));
        if (dist > 1) continue;
        if (p.isAlive) continue;
        target = { kind: 'player', userId: p.userId };
        break;
      }
    }
    if (!target) {
      this.notifyHud('No body to plant on');
      return;
    }
    const equippedId = this.inventory.equipped;
    const inst = equippedId ? this.inventory.items.find((i) => i.instanceId === equippedId) : null;
    if (!inst) {
      this.notifyHud('Equip something first to plant it');
      return;
    }
    void this.match.sendMatch(OpCode.C2S_PLANT_ITEM, {
      instanceId: inst.instanceId,
      target,
    });
    this.notifyHud(`Planted ${ITEMS[inst.itemId]?.name ?? inst.itemId}`);
  }

  /** NumPad5 from the original macro: open the PDA if it's in the inventory. */
  private handleUsePda(): void {
    const pda = this.inventory.items.find((i) => i.itemId === 'pda');
    if (!pda) {
      this.notifyHud('No PDA');
      return;
    }
    void this.match.sendMatch(OpCode.C2S_INV_USE, { instanceId: pda.instanceId });
  }

  /** Ctrl-held name reveal: brighten labels and (todo) reveal classroom info. */
  private toggleNameReveal(on: boolean): void {
    if (this.nameRevealActive === on) return;
    this.nameRevealActive = on;
    for (const sprite of this.players.values()) {
      sprite.label.setColor(on ? '#ffe680' : '#ffffff');
    }
  }

  /** Render a generic vertical menu of verbs at (screenX, screenY). */
  private renderContextMenu(
    title: string,
    verbs: Array<{ label: string; run: () => void }>,
    screenX: number,
    screenY: number,
  ): void {
    document.querySelectorAll('.pyrce-ctx-menu').forEach((n) => n.remove());
    if (verbs.length === 0) verbs.push({ label: '(no verbs)', run: () => {} });
    const m = document.createElement('div');
    m.className = 'pyrce-ctx-menu';
    m.style.cssText = `position:fixed;left:${screenX}px;top:${screenY}px;z-index:3000;
      background:#0d1320;border:1px solid #4477aa;color:#dde;
      font-family:Arial,sans-serif;font-size:13px;min-width:160px;
      box-shadow:0 4px 14px #0008;`;
    const head = document.createElement('div');
    head.textContent = title;
    head.style.cssText = 'padding:6px 10px;border-bottom:1px solid #224;color:#88aaee;';
    m.appendChild(head);
    for (const v of verbs) {
      const row = document.createElement('div');
      row.textContent = v.label;
      row.style.cssText = 'padding:6px 10px;cursor:pointer;';
      row.addEventListener('mouseenter', () => (row.style.background = '#1a2740'));
      row.addEventListener('mouseleave', () => (row.style.background = ''));
      row.addEventListener('click', () => {
        v.run();
        m.remove();
      });
      m.appendChild(row);
    }
    document.body.appendChild(m);
    const dismiss = (e: MouseEvent) => {
      if (!m.contains(e.target as Node)) {
        m.remove();
        document.removeEventListener('mousedown', dismiss, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
  }

  /**
   * Right-clicking another player → verbs that apply to that target. Role
   * and distance are evaluated client-side so the menu only lists what's
   * possible; the server re-checks every action.
   */
  private openPlayerContextMenu(target: PublicPlayerInGame, screenX: number, screenY: number): void {
    const me = this.players.get(this.match.userId)?.state;
    const myRole = this.gameInfo.role?.roleId;
    const isSelf = target.userId === this.match.userId;
    const dist = me ? Math.max(Math.abs(me.x - target.x), Math.abs(me.y - target.y)) : 99;

    const verbs: Array<{ label: string; run: () => void }> = [];
    if (!isSelf && dist <= 7) {
      verbs.push({
        label: 'View Profile',
        run: () => void this.match.sendMatch(OpCode.C2S_VIEW_PROFILE, { userId: target.userId }),
      });
    }
    if (!isSelf && dist <= 1 && target.isAlive) {
      verbs.push({ label: 'Attack', run: () => this.handleAttack() });
      verbs.push({
        label: 'Shove',
        run: () => void this.match.sendMatch(OpCode.C2S_SHOVE, {}),
      });
      // Plant only makes sense if you're holding something.
      if (this.inventory.equipped) {
        verbs.push({ label: 'Plant Item', run: () => this.handlePlantOnTarget() });
      }
    }
    if (!isSelf) {
      verbs.push({
        label: 'Vote-Kick',
        run: () =>
          void this.match.sendMatch(OpCode.C2S_VOTE_KICK, { targetUserId: target.userId }),
      });
    }
    // Doppel/Vampire actually target an adjacent corpse, not a player —
    // surface them only when there IS such a corpse available.
    const adjCorpse =
      me &&
      Array.from(this.corpseSprites.values()).find(
        (c) => Math.max(Math.abs(me.x - c.data.x), Math.abs(me.y - c.data.y)) <= 1,
      );
    if (myRole === 'doppelganger' && adjCorpse) {
      verbs.push({ label: 'Doppel: Copy', run: () => this.handleDoppelCopy() });
    }
    if (myRole === 'vampire' && adjCorpse) {
      verbs.push({ label: 'Vampire: Drain', run: () => this.handleVampireDrain() });
    }
    this.renderContextMenu(
      target.disguiseDisplayName ?? target.displayName,
      verbs,
      screenX,
      screenY,
    );
  }

  /**
   * Right-clicking the world (empty tile) → general verbs that don't need
   * a player target: drop, vote, role abilities, light switch, cameras…
   */
  private openWorldContextMenu(screenX: number, screenY: number): void {
    const me = this.players.get(this.match.userId)?.state;
    const myRole = this.gameInfo.role?.roleId;
    const myRoleId = myRole ?? '';
    const verbs: Array<{ label: string; run: () => void }> = [];

    const adj = (x: number, y: number): boolean =>
      !!me && Math.max(Math.abs(me.x - x), Math.abs(me.y - y)) <= 1;
    const hasAdjacent = (list?: ReadonlyArray<{ x: number; y: number }>) =>
      !!list && list.some((e) => adj(e.x, e.y));
    const hasItem = (id: string) => this.inventory.items.some((i) => i.itemId === id);

    if (this.inventory.equipped) {
      verbs.push({ label: 'Drop Equipped', run: () => this.handleDropEquipped() });
    }
    // Wash needs a sink (bathroom floor) — server checks the tile path; we
    // approximate by requiring the player to actually be bloody.
    if (me && (me.bloody ?? 0) > 0) {
      verbs.push({
        label: 'Wash Blood',
        run: () => void this.match.sendMatch(OpCode.C2S_WASH, {}),
      });
    }
    if (hasAdjacent(this.map.lightSwitches)) {
      verbs.push({ label: 'Light Switch', run: () => this.handleLightSwitch() });
    }
    // Push container: any non-stationed container adjacent.
    const pushableContainers = (this.map.containers ?? []).filter(
      (c) => !c.kind.includes('Containers_Stationed'),
    );
    if (hasAdjacent(pushableContainers)) {
      verbs.push({ label: 'Push Container', run: () => this.handlePushContainer() });
    }
    const adjacentCorpse = Array.from(this.corpseSprites.values()).find((c) =>
      adj(c.data.x, c.data.y),
    );
    if (adjacentCorpse) {
      verbs.push({ label: 'Push Corpse', run: () => this.handlePushCorpse() });
      verbs.push({ label: 'Pull Corpse', run: () => this.handlePullCorpse() });
    }
    if (hasAdjacent(this.map.cameras) || hasAdjacent(this.map.monitors)) {
      verbs.push({ label: 'Camera View', run: () => this.handleCameraCycle() });
    }
    if (hasAdjacent(this.map.monitors)) {
      verbs.push({
        label: 'View Tapes',
        run: () => void this.match.sendMatch(OpCode.C2S_TAPE_VIEW, {}),
      });
      // Only the killer roles can tamper with tapes (DM Delete_Tapes verb).
      if (
        myRoleId === 'killer' ||
        myRoleId === 'witch' ||
        myRoleId === 'vampire' ||
        myRoleId === 'doppelganger'
      ) {
        verbs.push({
          label: 'Delete Tapes',
          run: () => void this.match.sendMatch(OpCode.C2S_TAPE_DELETE, {}),
        });
      }
    }
    // Role abilities are role-specific. List the ones the current role has.
    if (myRoleId === 'witch' || myRoleId === 'vampire') {
      verbs.push({ label: 'Use Role Ability', run: () => this.handleRoleAbility() });
    }
    // Craft Spear: Knife + Mop + Tape (Containers.dm recipe).
    if (hasItem('knife') && hasItem('mop') && hasItem('tape')) {
      verbs.push({ label: 'Craft Spear', run: () => this.handleCraft('spear') });
    }
    // Always-on verbs.
    verbs.push({ label: 'Vote End Game', run: () => this.handleEndGameVote() });
    if (this.players.size > 1) {
      verbs.push({ label: 'Vote-Kick (pick)', run: () => this.openVoteKickPicker() });
    }
    this.renderContextMenu('Verbs', verbs, screenX, screenY);
  }

  private handleHotkey(slot: 1 | 2 | 3 | 4 | 5): void {
    const ref = this.inventory.hotkeys[slot - 1];
    if (!ref) return;
    const inst = this.inventory.items.find((i) => i.instanceId === ref);
    const def = inst ? ITEMS[inst.itemId] : null;
    // Death Note needs a target; open the Kira picker before sending use.
    if (def?.use?.kind === 'death_note_write') {
      this.openTargetPicker('Pick a victim for the Death Note', (targetUserId) => {
        void this.match.sendMatch(OpCode.C2S_INV_USE, {
          instanceId: ref,
          targetUserId,
        });
      });
      return;
    }
    // Weapons toggle-equip; pressing the hotkey again unequips so the
    // killer can re-hide the knife. Items with a `use` action (consumables)
    // fire C2S_INV_USE; everything else just toggles equip too.
    if (def?.weapon || !def?.use) {
      const op = this.inventory.equipped === ref ? null : ref;
      void this.match.sendMatch(OpCode.C2S_INV_EQUIP, { instanceId: op });
      return;
    }
    void this.match.sendMatch(OpCode.C2S_INV_USE, { instanceId: ref });
  }

  /** Right-side modal listing alive other players; calls back when one is clicked. */
  private openTargetPicker(title: string, onPick: (userId: string) => void): void {
    const parent = this.game.canvas.parentElement;
    if (!parent) return;
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.right = '12px';
    container.style.top = '70px';
    container.style.minWidth = '220px';
    container.style.background = 'rgba(0,0,0,0.85)';
    container.style.border = '1px solid #88aaff';
    container.style.padding = '8px';
    container.style.zIndex = '2200';
    container.style.color = '#ffffff';
    container.style.fontFamily = 'Arial, sans-serif';
    container.style.fontSize = '13px';
    const heading = document.createElement('div');
    heading.textContent = title;
    heading.style.fontWeight = 'bold';
    heading.style.marginBottom = '6px';
    container.appendChild(heading);
    let chosen = false;
    for (const sprite of this.players.values()) {
      if (sprite.userId === this.match.userId) continue;
      if (!sprite.state.isAlive) continue;
      const row = document.createElement('button');
      row.textContent = sprite.state.displayName;
      row.style.display = 'block';
      row.style.width = '100%';
      row.style.margin = '2px 0';
      row.style.padding = '6px 8px';
      row.style.cursor = 'pointer';
      row.style.background = '#223344';
      row.style.color = '#ffffff';
      row.style.border = '1px solid #88aaff';
      row.style.fontSize = '13px';
      row.addEventListener('click', () => {
        if (chosen) return;
        chosen = true;
        onPick(sprite.userId);
        container.remove();
      });
      container.appendChild(row);
    }
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.display = 'block';
    cancel.style.width = '100%';
    cancel.style.marginTop = '6px';
    cancel.style.padding = '6px';
    cancel.style.cursor = 'pointer';
    cancel.style.background = '#332222';
    cancel.style.color = '#ffaaaa';
    cancel.style.border = '1px solid #aa6666';
    cancel.addEventListener('click', () => container.remove());
    container.appendChild(cancel);
    parent.appendChild(container);
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
          // Late-arrival placeholder; the next initial snapshot fills in the
          // real demographics. Use neutral defaults so the sprite renders.
          this.spawnPlayer({
            userId: m.userId,
            displayName: '...',
            gender: 'male',
            hairId: 'BlackBoyHair',
            hairColor: 'black',
            x: m.x,
            y: m.y,
            facing: m.facing,
            hp: 100,
            maxHp: 100,
            isAlive: true,
            equippedItemId: m.equippedItemId,
            equippedItemBloody: m.equippedItemBloody,
            bloody: m.bloody ?? 0,
          });
          return;
        }
        this.moveSprite(sprite, m.x, m.y, m.facing);
        this.updateEquippedSprite(sprite, m.equippedItemId, m.equippedItemBloody);
        this.applyBloodyTint(sprite, m.bloody ?? 0);
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
        this.scene.get('Hud').events.emit('inv:refresh');
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
      case OpCode.S2C_CONTAINER_MOVED: {
        const moved = parsePayload<S2CContainerMoved>(data);
        if (!moved) return;
        // Match by exact source coords — proximity matching mis-targets when
        // multiple containers cluster within 1 tile of the destination.
        const c = this.containerHotspots.find(
          (h) => h.x === moved.fromX && h.y === moved.fromY,
        );
        if (c) {
          c.x = moved.x;
          c.y = moved.y;
          c.id = `c@${moved.x},${moved.y}`;
          c.rect.setPosition(moved.x * TILE + TILE / 2, moved.y * TILE + TILE / 2);
        }
        break;
      }
      case OpCode.S2C_CRAFT_RESULT: {
        const r = parsePayload<S2CCraftResult>(data);
        if (!r) return;
        this.notifyHud(r.ok ? `crafted ${r.recipeId}` : `craft failed: ${r.error}`);
        break;
      }
      case OpCode.S2C_LIGHT_STATE: {
        const l = parsePayload<S2CLightState>(data);
        if (!l) return;
        this.lightsOff = new Set(l.offTags);
        this.refreshLightOverlays();
        this.refreshSwitchSprites();
        break;
      }
      case OpCode.S2C_BLOOD_DRIP: {
        const d = parsePayload<S2CBloodDrip>(data);
        if (!d) return;
        this.spawnBloodDrip(d.x, d.y, d.intensity);
        break;
      }
      case OpCode.S2C_CAMERA_FEED: {
        const f = parsePayload<S2CCameraFeed>(data);
        if (!f) return;
        this.peekCamera(f.x, f.y, f.durationMs);
        break;
      }
      case OpCode.S2C_TAPE_RESULT: {
        const t = parsePayload<S2CTapeResult>(data);
        if (!t) return;
        const r = t.result;
        if (r === 'deleted') this.notifyHud('Tapes have been deleted...');
        else if (r === 'wrong_mode') this.notifyHud('No useful evidence on these tapes.');
        else if (r === 'no_killer') this.notifyHud('Tapes show nothing remarkable.');
        else this.showTapeHairColor(r);
        break;
      }
      case OpCode.S2C_EYE_OFFER: {
        const o = parsePayload<S2CEyeOffer>(data);
        if (!o) return;
        this.openEyeOfferDialog(o.fromDisplayName);
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
          // Fall-down anim instead of an instant alpha pop.
          this.tweens.add({
            targets: [s.rect, s.hair],
            angle: 90,
            alpha: 0.55,
            duration: 400,
          });
          s.rect.setTint(0x666666);
          s.label.setText(`†${d.victimRealName || s.state.displayName}`);
          this.updateHpBar(s);
        }
        if (d.userId === this.match.userId) this.showDeathOverlay(d);
        this.notifyHud(`${d.victimRealName || s?.state.displayName || d.userId.slice(0, 6)} died (${d.cause})`);
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
        if (f.key === 'quickdash') this.spawnDashTrail(f.x, f.y);
        break;
      }
      case OpCode.S2C_FX_SWING: {
        const s = parsePayload<S2CFxSwing>(data);
        if (!s) return;
        this.playSwingFx(s.userId);
        break;
      }
      case OpCode.S2C_PLAYER_STATUS: {
        const st = parsePayload<S2CPlayerStatus>(data);
        if (!st) return;
        this.scene.get('Hud').events.emit('hud:status', st);
        break;
      }
      case OpCode.S2C_FX_BUTTERFLY: {
        const f = parsePayload<S2CFxButterfly>(data);
        if (!f) return;
        this.playButterfly(f.x * TILE + TILE / 2, f.y * TILE + TILE / 2);
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
        this.notifyHud(`${p.displayName}: ${p.condition} (${p.hp}/${p.maxHp})`);
        break;
      }
      case OpCode.S2C_SEARCH_REQUEST: {
        const r = parsePayload<S2CSearchRequest>(data);
        if (!r) return;
        this.openSearchConsent(r);
        break;
      }
      case OpCode.S2C_SEARCH_DENIED: {
        const r = parsePayload<S2CSearchDenied>(data);
        if (!r) return;
        this.notifyHud(r.reason);
        break;
      }
      case OpCode.S2C_VOTE_KICK_TALLY: {
        const t = parsePayload<S2CVoteKickTally>(data);
        if (!t) return;
        if (t.resolved) this.notifyHud(`${t.targetDisplayName} was vote-kicked`);
        else this.notifyHud(`Kick vote ${t.targetDisplayName}: ${t.yes}/${t.alive}`);
        break;
      }
      case OpCode.S2C_SELF_ROLE_STATE: {
        const s = parsePayload<S2CSelfRoleState>(data);
        if (!s) return;
        if (s.witchRevivesLeft !== undefined) {
          this.notifyHud(`Witch: ${s.witchRevivesLeft} revives left`);
        }
        if (s.vampireDrained !== undefined) {
          this.notifyHud(`Vampire: ${s.vampireDrained} drained`);
        }
        break;
      }
      case OpCode.S2C_STUDENT_ROSTER: {
        const r = parsePayload<S2CStudentRoster>(data);
        if (!r) return;
        this.openStudentRoster(r);
        break;
      }
      case OpCode.S2C_FX_FEATHER: {
        const f = parsePayload<S2CFxFeather>(data);
        if (!f) return;
        this.playFeather(f.path);
        break;
      }
      case OpCode.S2C_GHOST_SENSE: {
        const g = parsePayload<S2CGhostSense>(data);
        if (!g) return;
        if (g.direction === null) this.notifyHud('Whisperer: no ghost sensed');
        else this.notifyHud(`Ghost is ${g.direction}, ~${g.distance} tiles away`);
        break;
      }
      case OpCode.S2C_PAPER_TEXT: {
        const p = parsePayload<S2CPaperText>(data);
        if (!p) return;
        this.openPaperModal(p);
        break;
      }
      case OpCode.S2C_PAPER_RECEIVED: {
        const p = parsePayload<S2CPaperReceived>(data);
        if (!p) return;
        this.notifyHud(`Paper from ${p.fromDisplayName}: "${p.text.slice(0, 80)}"`);
        break;
      }
      case OpCode.S2C_DOOR_CODE: {
        const c = parsePayload<S2CDoorCode>(data);
        if (!c) return;
        this.notifyHud(`Door code: ${c.code}`);
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
        this.time.delayedCall(0, () => {
          this.scene.get('Hud').events.emit('game:refresh');
          this.scene.get('ChatOverlay').events.emit('chat:system', `You are: ${r.roleName}`);
        });
        this.showRoleBanner(r);
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
        this.scene.start('EndScene', {
          result: r,
          matchId: this.match.currentMatchId ?? '',
        });
        this.scene.stop('Hud');
        break;
      }
    }
    this.scene.get('Hud').events.emit('inv:refresh');
  }

  private notifyHud(msg: string): void {
    this.scene.get('Hud').events.emit('inv:notify', msg);
  }

  /**
   * Big top-of-screen role-reveal banner shown for ~5s at round start.
   * Killer roles are tinted red so the player knows immediately. Self-only;
   * driven entirely by the local S2C_ROLE_ASSIGNED.
   */
  private showRoleBanner(r: { roleName: string; description?: string; roleId: string }): void {
    const { width } = this.scale.gameSize;
    const danger = ['killer', 'witch', 'vampire', 'doppelganger', 'kira', 'shinigami'];
    const isKillerRole = danger.includes(r.roleId);
    const color = isKillerRole ? '#ff5566' : '#88ddff';
    const banner = this.add
      .text(width / 2, 60, `You are: ${r.roleName}`, {
        fontFamily: 'Arial Black',
        fontSize: 28,
        color,
        stroke: '#000000',
        strokeThickness: 6,
        backgroundColor: '#000000bb',
        padding: { left: 16, right: 16, top: 8, bottom: 8 },
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(2500);
    if (r.description) {
      const desc = this.add
        .text(width / 2, 110, r.description, {
          fontFamily: 'Arial',
          fontSize: 14,
          color: '#dddddd',
          stroke: '#000000',
          strokeThickness: 4,
          backgroundColor: '#000000bb',
          padding: { left: 12, right: 12, top: 4, bottom: 4 },
          wordWrap: { width: 480 },
        })
        .setOrigin(0.5, 0)
        .setScrollFactor(0)
        .setDepth(2500);
      this.tweens.add({
        targets: [banner, desc],
        alpha: 0,
        delay: 5000,
        duration: 800,
        onComplete: () => {
          banner.destroy();
          desc.destroy();
        },
      });
    } else {
      this.tweens.add({
        targets: banner,
        alpha: 0,
        delay: 5000,
        duration: 800,
        onComplete: () => banner.destroy(),
      });
    }
  }

  /**
   * Refresh the dim overlay covering each lights-off area. Each tagged
   * light tile in the tilemap gets a 5-tile-radius dark patch when its
   * tag is in the off-set.
   */
  private lightOverlayByTag = new Map<string, Phaser.GameObjects.GameObject[]>();
  private refreshLightOverlays(): void {
    // Clear all existing overlays.
    for (const [, gos] of this.lightOverlayByTag) {
      for (const g of gos) g.destroy();
    }
    this.lightOverlayByTag.clear();
    if (this.lightsOff.size === 0) return;
    for (const tag of this.lightsOff) {
      const overlays: Phaser.GameObjects.GameObject[] = [];
      for (const l of this.map.lights ?? []) {
        if (l.tag !== tag) continue;
        const cx = l.x * TILE + TILE / 2;
        const cy = l.y * TILE + TILE / 2;
        const dim = this.add.rectangle(cx, cy, TILE * 11, TILE * 11, 0x000000, 0.55).setDepth(900);
        overlays.push(dim);
      }
      this.lightOverlayByTag.set(tag, overlays);
    }
  }

  /**
   * Tint the player sprite based on bloody count: 0 = none, 1-5 = light
   * red wash, 6+ = "very bloody" dark red. DM Weapons Attacks.dm tier.
   */
  private applyBloodyTint(sprite: PlayerSprite, bloody: number): void {
    if (bloody <= 0) {
      sprite.rect.clearTint?.();
      return;
    }
    const color = bloody >= 6 ? 0x882222 : 0xcc7777;
    sprite.rect.setTint?.(color);
  }

  /** Render a small drop on a tile that fades over a few seconds. */
  private spawnBloodDrip(x: number, y: number, intensity: number): void {
    const wx = x * TILE + TILE / 2;
    const wy = y * TILE + TILE / 2;
    const r = Math.min(8, 3 + intensity);
    const drip = this.add.circle(wx, wy, r, 0x661111, 0.7).setDepth(2);
    this.bloodDrips.push(drip);
    this.tweens.add({
      targets: drip,
      alpha: 0,
      duration: 30000,
      onComplete: () => drip.destroy(),
    });
    // Cap the drip count to avoid runaway memory.
    while (this.bloodDrips.length > 200) {
      const old = this.bloodDrips.shift();
      old?.destroy();
    }
  }

  /** Pan the camera to (x,y) for `durationMs`, then snap back to the player. */
  private peekCamera(x: number, y: number, durationMs: number): void {
    const wx = x * TILE + TILE / 2;
    const wy = y * TILE + TILE / 2;
    this.cameras.main.stopFollow();
    this.cameras.main.pan(wx, wy, 250);
    this.cameraReturnTimer?.remove();
    this.cameraReturnTimer = this.time.delayedCall(durationMs, () => {
      const me = this.players.get(this.match.userId);
      if (me) this.cameras.main.startFollow(me.rect, true, 0.1, 0.1);
    });
  }

  /** Show a small "tape evidence" modal with the killer's hair-color swatch. */
  private showTapeHairColor(hex: string): void {
    const parent = this.game.canvas.parentElement;
    if (!parent) return;
    const box = document.createElement('div');
    box.style.cssText =
      'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.92);border:2px solid #88aaff;padding:18px 24px;z-index:2400;color:#ffffff;font-family:Courier New,monospace;text-align:center';
    box.innerHTML = `<div style="margin-bottom:10px;color:#ffd866">Tape Review</div><div>The footage is blurry, but the suspect's hair appears to be:</div><div style="width:64px;height:64px;background:${hex};margin:14px auto;border:2px solid #88aaff"></div>`;
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.style.cssText =
      'padding:6px 16px;cursor:pointer;background:#223344;color:#ffffff;border:1px solid #88aaff';
    close.addEventListener('click', () => box.remove());
    box.appendChild(close);
    parent.appendChild(box);
    setTimeout(() => box.parentElement && box.remove(), 30000);
  }

  /** Yes/No modal for the Shinigami eye-deal offer. */
  private openEyeOfferDialog(fromUsername: string): void {
    const parent = this.game.canvas.parentElement;
    if (!parent) return;
    const box = document.createElement('div');
    box.style.cssText =
      'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.92);border:2px solid #ff8866;padding:18px 24px;z-index:2400;color:#ffffff;font-family:Courier New,monospace;max-width:420px;text-align:center';
    box.innerHTML = `<div style="margin-bottom:10px;color:#ffaa66">Shinigami's Offer</div><div>${fromUsername} offers you the Shinigami Eyes — you'll see everyone's true names, but trade away half your remaining life.</div><div style="margin-top:14px;display:flex;gap:14px;justify-content:center"></div>`;
    const buttons = box.lastElementChild as HTMLDivElement;
    const yes = document.createElement('button');
    yes.textContent = 'Accept';
    yes.style.cssText =
      'padding:6px 16px;cursor:pointer;background:#553311;color:#ffffff;border:1px solid #ff8866';
    yes.addEventListener('click', () => {
      void this.match.sendMatch(OpCode.C2S_ACCEPT_EYES, { accept: true });
      box.remove();
    });
    const no = document.createElement('button');
    no.textContent = 'Decline';
    no.style.cssText =
      'padding:6px 16px;cursor:pointer;background:#223344;color:#ffffff;border:1px solid #88aaff';
    no.addEventListener('click', () => {
      void this.match.sendMatch(OpCode.C2S_ACCEPT_EYES, { accept: false });
      box.remove();
    });
    buttons.appendChild(yes);
    buttons.appendChild(no);
    parent.appendChild(box);
    setTimeout(() => box.parentElement && box.remove(), 30000);
  }

  // ---------- rendering helpers ----------

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
   * Register walk animations per (gender, direction). Keys:
   * `male.walk.S` / `female.walk.S` / etc. Played on `S2C_PLAYER_MOVED`;
   * we let it run through one cycle and leave the sprite on the idle
   * frame between steps.
   */
  private registerCharacterAnims(): void {
    if (this.anims.exists('male.walk.S')) return;
    const atlasTex = this.textures.get(ATLAS_KEY);
    for (const dir of ['S', 'N', 'E', 'W'] as const) {
      for (const [g, base] of [
        ['male', 'MaleBase'],
        ['female', 'FemaleBase'],
      ] as const) {
        this.anims.create({
          key: `${g}.walk.${dir}`,
          frames: [0, 1, 2, 3].map((f) => ({
            key: ATLAS_KEY,
            frame: `hair-overlays/${base}/_/${dir}/${f}`,
          })),
          frameRate: 10,
          repeat: 0,
        });
      }
      // One walk anim per (hair, dir). Skip hairs whose frames aren't in
      // the atlas (sparse coverage of some hair option names).
      for (const hair of [...HAIR_OPTIONS_MALE, ...HAIR_OPTIONS_FEMALE]) {
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

  /** Spawn three flapping butterflies that drift outward and fade. */
  playButterfly(worldX: number, worldY: number): void {
    const atlasTex = this.textures.get(ATLAS_KEY);
    if (!this.anims.exists('fx.butterfly')) {
      const frames = [0, 1, 2, 3]
        .map((f) => `mh-icons/butterfly/_/S/${f}`)
        .filter((k) => atlasTex.has(k));
      if (frames.length === 0) return;
      this.anims.create({
        key: 'fx.butterfly',
        frames: frames.map((k) => ({ key: ATLAS_KEY, frame: k })),
        frameRate: 8,
        repeat: 5,
      });
    }
    for (let i = 0; i < 3; i++) {
      const fx = this.add.sprite(worldX, worldY, ATLAS_KEY).setDepth(900);
      fx.play('fx.butterfly');
      const dx = (Math.random() - 0.5) * 80;
      const dy = (Math.random() - 0.5) * 80 - 30;
      this.tweens.add({
        targets: fx,
        x: worldX + dx,
        y: worldY + dy,
        alpha: 0,
        duration: 1500,
        onComplete: () => fx.destroy(),
      });
    }
  }

  /**
   * Play the smoke puff animation at world coords. Hooked to the smoke_bomb
   * use op; also exposed for any client-side trigger.
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
    fx.once('animationcomplete', () => fx.destroy());
  }

  /**
   * Render the wielded weapon as an underlay beneath the player, the way
   * DM did (`mob.underlays += 'knife.dmi'`). One frame per facing — the
   * weapon icon "rotates" as the player turns. Atomic update: replaces
   * the underlay sprite when the equipped item or facing changes.
   */
  private updateEquippedSprite(sprite: PlayerSprite, itemId: string | null, _bloody = false): void {
    sprite.equippedItemId = itemId;
    const cardinal = facingToCardinal(sprite.state.facing);
    const frame = itemId ? wieldedItemFrame(itemId, cardinal) : undefined;
    const atlas = this.textures.get(ATLAS_KEY);
    if (!frame || !atlas.has(frame)) {
      sprite.weapon?.destroy();
      delete sprite.weapon;
      return;
    }
    if (!sprite.weapon) {
      // Underlay sits between the floor (depth 0) and the body (depth 2).
      sprite.weapon = this.add
        .image(sprite.rect.x, sprite.rect.y, ATLAS_KEY, frame)
        .setDepth(1.95);
    } else {
      sprite.weapon.setFrame(frame);
    }
  }


  private spawnPlayer(p: PublicPlayerInGame): void {
    const x = p.x * TILE + TILE / 2;
    const y = p.y * TILE + TILE / 2;
    // Hidden hit-zone under the sprite for click/right-click; not stroked
    // so it never paints a visible ring. The DM original had no outline.
    const outline = this.add.rectangle(x, y, TILE - 2, TILE - 2, 0x000000, 0);
    const cardinal = facingToCardinal(p.facing);
    const frame = CHARACTER_SPRITES[p.gender][cardinal];
    const rect = this.add.sprite(x, y, ATLAS_KEY, frame).setDepth(2);
    // Doppelganger: hair + nameplate are picked from the disguise target;
    // otherwise use what the server picked at game start.
    const hairId = p.disguiseHairId ?? p.hairId;
    const displayName = p.disguiseDisplayName ?? p.displayName;
    const hairFr = hairFrame(hairId, cardinal);
    const atlasTex = this.textures.get(ATLAS_KEY);
    const hair = this.add
      .sprite(x, y, ATLAS_KEY, atlasTex.has(hairFr) ? hairFr : frame)
      .setDepth(rect.depth + 0.01);
    // Atlas hair is grayscale; FILL mode paints the silhouette in the
    // chosen color (default MULTIPLY would mute bright tints to mud).
    hair.setTint(hairTintFor(p.hairColor)).setTintMode(TINT_FILL);
    const label = this.add
      .text(x, y - TILE / 2 - 4, displayName, {
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
    this.players.set(p.userId, sprite);
    this.updateHpBar(sprite);
    this.applyBloodyTint(sprite, p.bloody ?? 0);
    if (p.equippedItemId) {
      this.updateEquippedSprite(sprite, p.equippedItemId, p.equippedItemBloody);
    }
    // Right-click → context menu of in-range verbs (matches DM's
    // right-click verb list). Replaces the old letter-key shortcuts.
    rect.setInteractive({ useHandCursor: true });
    rect.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown() || pointer.event.shiftKey) {
        const ev = pointer.event as MouseEvent;
        this.openPlayerContextMenu(p, ev.clientX, ev.clientY);
      }
    });
  }

  private despawnPlayer(userId: string): void {
    const sprite = this.players.get(userId);
    if (!sprite) return;
    sprite.tween?.stop();
    sprite.rect.destroy();
    sprite.hair.destroy();
    sprite.weapon?.destroy();
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
    const tag = c.discovered ? `† ${c.victimRealName || c.victimDisplayName}` : `† ${c.victimDisplayName}`;
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
    const gender = sprite.state.gender;
    sprite.rect.play(`${gender}.walk.${cardinal}`, true);
    if (this.anims.exists(`hair.${sprite.hairId}.walk.${cardinal}`)) {
      sprite.hair.play(`hair.${sprite.hairId}.walk.${cardinal}`, true);
    }
    sprite.rect.once('animationcomplete', () => {
      sprite.rect.setFrame(CHARACTER_SPRITES[gender][cardinal]);
      sprite.hair.setFrame(hairFrame(sprite.hairId, cardinal));
    });
    // Wielded-weapon underlay rotates with facing; refresh its frame here
    // so it matches the new direction even when the equipped item didn't change.
    if (sprite.weapon && sprite.equippedItemId) {
      const wf = wieldedItemFrame(sprite.equippedItemId, cardinal);
      if (wf && this.textures.get(ATLAS_KEY).has(wf)) sprite.weapon.setFrame(wf);
    }
    const targets: Phaser.GameObjects.GameObject[] = [
      sprite.rect,
      sprite.hair,
      sprite.outline,
      sprite.label,
      sprite.hpBg,
      sprite.hpFill,
    ];
    if (sprite.weapon) targets.push(sprite.weapon);
    if (sprite.crown) targets.push(sprite.crown);
    sprite.tween = this.tweens.add({
      targets,
      x: (t: Phaser.GameObjects.GameObject) => {
        if (t === sprite.hpFill) return targetX - (TILE - 4) / 2;
        return targetX;
      },
      y: (t: Phaser.GameObjects.GameObject) => {
        if (t === sprite.label) return targetY - TILE / 2 - 4;
        if (t === sprite.hpBg || t === sprite.hpFill) return targetY - TILE / 2 - 18;
        if (t === sprite.crown) return targetY - TILE / 2 - 4;
        return targetY;
      },
      duration: MOVE_TWEEN_MS,
      // Linear keeps the speed constant across consecutive tile-steps when
      // the player holds an arrow; ease-in/out per-tween reads as pulsing.
      ease: 'Linear',
    });
    sprite.state = { ...sprite.state, x, y, facing };
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
      // Right-click → door context menu (Open/Close + Escape if applicable).
      sprite.setInteractive({ useHandCursor: true });
      sprite.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
        if (!pointer.rightButtonDown() && !pointer.event.shiftKey) return;
        const ev = pointer.event as MouseEvent;
        this.openDoorContextMenu(d.x, d.y, d.kind, ev.clientX, ev.clientY);
      });
    }
  }

  /** Door right-click menu: Open/Close (server toggles) + Escape if it's the steel door. */
  private openDoorContextMenu(
    x: number,
    y: number,
    kind: string,
    sx: number,
    sy: number,
  ): void {
    const me = this.players.get(this.match.userId)?.state;
    const dist = me ? Math.max(Math.abs(me.x - x), Math.abs(me.y - y)) : 99;
    const verbs: Array<{ label: string; run: () => void }> = [];
    if (dist <= 1) {
      verbs.push({
        label: 'Open / Close',
        run: () => void this.match.sendMatch(OpCode.C2S_DOOR_TOGGLE, { x, y }),
      });
      if (kind === '/obj/Escape_Door') {
        verbs.push({
          label: 'Escape (needs Key Card)',
          run: () => void this.match.sendMatch(OpCode.C2S_ESCAPE_DOOR, {}),
        });
      }
    } else {
      verbs.push({ label: '(walk closer)', run: () => {} });
    }
    this.renderContextMenu('Door', verbs, sx, sy);
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
      // Server identifies containers by random id; client keys by coord
      // and the server resolves to the real id on each request.
      const id = `c@${c.x},${c.y}`;
      this.containerHotspots.push({ id, x: c.x, y: c.y, rect });
      const stationed = c.kind.includes('Containers_Stationed');
      rect.setInteractive({ useHandCursor: true });
      rect.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
        if (!pointer.rightButtonDown() && !pointer.event.shiftKey) return;
        const ev = pointer.event as MouseEvent;
        const hot = this.containerHotspots.find((h) => h.rect === rect);
        if (!hot) return;
        this.openContainerContextMenu(hot.x, hot.y, stationed, ev.clientX, ev.clientY);
      });
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

/**
 * Map a hair color word from the demographic roll to the tint applied to
 * the (grayscale) hair sprite. DM stored the colour as `mob.color = rgb()`
 * and applied it on every frame; here we do it once at spawn.
 */
function hairTintFor(color: string): number {
  switch (color) {
    case 'black':    return 0x222222;
    case 'white':    return 0xf2efe6;
    case 'silver':   return 0xc0c8d0;
    case 'gray':     return 0x888888;
    case 'blonde':   return 0xeed98a;
    case 'yellow':   return 0xf7e93a;
    case 'amber':    return 0xd99c2a;
    case 'orange':   return 0xe07a1f;
    case 'red':      return 0xcc2e2e;
    case 'crimson':  return 0x8a1c2e;
    case 'pink':     return 0xff8fc0;
    case 'magenta':  return 0xc024a0;
    case 'brown':    return 0x7a4a26;
    // Auburn/reddish-brown — sits clearly between brown and red, no longer
    // dark enough to read as black.
    case 'chestnut': return 0xb05a2a;
    case 'green':    return 0x4caf50;
    case 'lime':     return 0xb6ed3a;
    case 'mint':     return 0x6fe0a8;
    case 'teal':     return 0x2a8e8e;
    case 'cyan':     return 0x2bd9d9;
    case 'blue':     return 0x4477cc;
    case 'navy':     return 0x1f2a72;
    case 'purple':   return 0x9b4ee0;
    case 'lavender': return 0xb59cd1;
    default:         return 0xffffff;
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
