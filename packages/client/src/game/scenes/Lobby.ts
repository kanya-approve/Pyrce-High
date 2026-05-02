import type { Presence } from '@heroiclabs/nakama-js';
import {
  MatchPhase,
  MODES,
  OpCode,
  type S2CLobbyState,
  type S2CPhaseChange,
  type S2CVoteModeTally,
  selectableModes,
} from '@pyrce/shared';
import { Scene } from 'phaser';
import type { NakamaMatchClient } from '../../net/matchClient';

interface LobbyData {
  matchId: string;
  presences: Presence[];
  hostUserId: string | null;
}

/**
 * Joined-lobby waiting room. Shows the player list (updated via match
 * presence events). Host has a Start button that sends
 * `C2S_LOBBY_START_GAME` to the match handler; the resulting
 * `S2C_PHASE_CHANGE` to InGame triggers the scene transition into
 * GameWorld.
 */
export class Lobby extends Scene {
  private match!: NakamaMatchClient;
  private matchId!: string;
  private hostUserId: string | null = null;
  private presences = new Map<string, Presence>();
  /** Server-rolled display names ("Male with brown hair") keyed by userId. */
  private displayNames = new Map<string, string>();
  private playerListText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private startButton: Phaser.GameObjects.GameObject[] = [];
  private modeButtons = new Map<
    string,
    { bg: Phaser.GameObjects.Rectangle; txt: Phaser.GameObjects.Text }
  >();
  private myVote: string | null = null;
  private tally: { [modeId: string]: number } = {};
  private offMatchData: (() => void) | null = null;
  private offPresence: (() => void) | null = null;

  constructor() {
    super('Lobby');
  }

  init(data: LobbyData): void {
    this.matchId = data.matchId;
    this.hostUserId = data.hostUserId ?? null;
    this.presences.clear();
    for (const p of data.presences ?? []) {
      this.presences.set(p.user_id, p);
    }
  }

  create(): void {
    this.match = this.game.registry.get('match') as NakamaMatchClient;
    const { width, height } = this.scale.gameSize;

    // Lobby chat overlay so people can talk while waiting for the round.
    if (!this.scene.isActive('ChatOverlay')) this.scene.launch('ChatOverlay');

    this.add
      .text(width / 2, 50, `Lobby: ${this.matchId.slice(0, 24)}…`, {
        fontFamily: 'Arial Black',
        fontSize: 22,
        color: '#ffffff',
      })
      .setOrigin(0.5, 0);

    const subtitle = this.amHost()
      ? 'You are the host. Click Start to begin.'
      : 'Waiting for the host to start…';
    this.add
      .text(width / 2, 90, subtitle, {
        fontFamily: 'Arial',
        fontSize: 14,
        color: '#888888',
      })
      .setOrigin(0.5, 0);

    this.buildModeVoteButtons(width);

    this.playerListText = this.add.text(80, 140, '', {
      fontFamily: 'Courier New',
      fontSize: 16,
      color: '#dddddd',
    });

    this.statusText = this.add
      .text(width / 2, height - 30, '', {
        fontFamily: 'Arial',
        fontSize: 14,
        color: '#aaaaaa',
      })
      .setOrigin(0.5);

    this.makeButton(width / 2 - 240, height - 90, 200, 40, '← Leave', () => this.handleLeave());
    // Start button is rendered/removed dynamically as host status changes
    // (e.g. after auto-return-to-lobby or host migration). See refreshHostButton().
    this.refreshHostButton();

    this.offPresence = this.match.onPresenceChange((ev) => {
      for (const p of ev.joins ?? []) this.presences.set(p.user_id, p);
      for (const p of ev.leaves ?? []) this.presences.delete(p.user_id);
      this.renderPlayers();
    });

    this.offMatchData = this.match.onMatchData((msg) => {
      if (msg.op_code === OpCode.S2C_PHASE_CHANGE) {
        const payload = parsePayload<S2CPhaseChange>(msg.data);
        if (payload && payload.phase === MatchPhase.InGame && payload.players) {
          this.scene.start('GameWorld', {
            matchId: this.matchId,
            players: payload.players,
            gameModeId: payload.gameModeId ?? null,
            hostUserId: this.hostUserId,
          });
        }
      } else if (msg.op_code === OpCode.S2C_LOBBY_STATE) {
        const lobby = parsePayload<S2CLobbyState>(msg.data);
        if (lobby) {
          this.displayNames.clear();
          for (const e of lobby.entries) {
            this.displayNames.set(e.userId, e.displayName);
            if (e.isHost) this.hostUserId = e.userId;
          }
          this.renderPlayers();
          this.refreshHostButton();
        }
      } else if (msg.op_code === OpCode.S2C_VOTE_MODE_TALLY) {
        const t = parsePayload<S2CVoteModeTally>(msg.data);
        if (t) {
          this.tally = t.tally;
          this.renderModeButtons();
        }
      } else if (msg.op_code === OpCode.S2C_ERROR) {
        const err = parsePayload<{ code: string; message?: string }>(msg.data);
        if (err) this.statusText.setText(`Server: ${err.message ?? err.code}`).setColor('#ff8080');
      }
    });

    this.renderPlayers();
  }

  shutdown(): void {
    this.offPresence?.();
    this.offMatchData?.();
    this.offPresence = null;
    this.offMatchData = null;
    // Leave ChatOverlay running — GameWorld keeps it; LobbyBrowser stops it.
  }

  private amHost(): boolean {
    return !!this.hostUserId && this.hostUserId === this.match.userId;
  }

  private renderPlayers(): void {
    // Async match-data callbacks can fire after a scene transition has
    // already destroyed our text object — Phaser will then NPE deep
    // inside Frame.updateUVs when we try to setText. Guard against it.
    if (!this.playerListText || !this.playerListText.scene || !this.playerListText.active) {
      return;
    }
    if (this.presences.size === 0) {
      this.playerListText.setText('(no players yet)');
      return;
    }
    const lines: string[] = [];
    let i = 1;
    for (const p of this.presences.values()) {
      const tag = p.user_id === this.match.userId ? ' (you)' : '';
      const host = p.user_id === this.hostUserId ? ' [host]' : '';
      const label = this.displayNames.get(p.user_id) ?? '...';
      lines.push(`${String(i).padStart(2, ' ')}.  ${label}${tag}${host}`);
      i++;
    }
    this.playerListText.setText(lines.join('\n'));
  }

  private async handleLeave(): Promise<void> {
    try {
      await this.match.leaveMatch(this.matchId);
    } catch (err) {
      console.warn('[pyrce] leaveMatch warning', err);
    }
    this.scene.start('LobbyBrowser');
  }

  private async handleStart(): Promise<void> {
    this.statusText.setText('Starting…').setColor('#aaaaaa');
    try {
      // Server picks the leading mode if no explicit gameModeId is sent.
      await this.match.sendMatch(OpCode.C2S_LOBBY_START_GAME, {});
    } catch (err) {
      console.error('[pyrce] start failed', err);
      this.statusText.setText(`Start failed: ${(err as Error).message}`).setColor('#ff8080');
    }
  }

  /** One button per registered mode. Click toggles your vote. */
  private buildModeVoteButtons(width: number): void {
    const modes = selectableModes();
    const btnW = 180;
    const btnH = 28;
    const gap = 6;
    const startY = 320;
    const x = width - btnW - 60;
    let y = startY;
    this.add
      .text(x, startY - 28, 'Vote a mode', {
        fontFamily: 'Arial Black',
        fontSize: 13,
        color: '#aaaaaa',
      })
      .setOrigin(0, 0);
    for (const mode of modes) {
      const bg = this.add
        .rectangle(x, y, btnW, btnH, 0x222a3a)
        .setOrigin(0, 0)
        .setStrokeStyle(1, 0x88aaff);
      const txt = this.add
        .text(x + 8, y + btnH / 2, mode.displayName, {
          fontFamily: 'Arial',
          fontSize: 13,
          color: '#ffffff',
        })
        .setOrigin(0, 0.5);
      bg.setInteractive({ useHandCursor: true });
      bg.on('pointerover', () => {
        if (this.myVote !== mode.id) bg.setFillStyle(0x334466);
      });
      bg.on('pointerout', () => this.renderModeButtons());
      bg.on('pointerdown', () => this.toggleVote(mode.id));
      txt.setInteractive({ useHandCursor: true });
      txt.on('pointerdown', () => this.toggleVote(mode.id));
      this.modeButtons.set(mode.id, { bg, txt });
      y += btnH + gap;
    }
    this.renderModeButtons();
  }

  private renderModeButtons(): void {
    for (const [modeId, { bg, txt }] of this.modeButtons) {
      const mine = this.myVote === modeId;
      bg.setFillStyle(mine ? 0x665522 : 0x222a3a);
      bg.setStrokeStyle(mine ? 2 : 1, mine ? 0xffd866 : 0x88aaff);
      const def = MODES[modeId as keyof typeof MODES];
      const count = this.tally[modeId] ?? 0;
      const tag = count > 0 ? `  (${count})` : '';
      txt.setText(`${def?.displayName ?? modeId}${tag}`);
    }
  }

  private toggleVote(modeId: string): void {
    const next = this.myVote === modeId ? null : modeId;
    this.myVote = next;
    void this.match.sendMatch(OpCode.C2S_VOTE_MODE, { modeId: next });
    this.renderModeButtons();
  }

  private makeButton(
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    onClick: () => void,
  ): Phaser.GameObjects.GameObject[] {
    const bg = this.add.rectangle(x, y, w, h, 0x223344).setOrigin(0, 0).setStrokeStyle(1, 0x88aaff);
    const txt = this.add
      .text(x + w / 2, y + h / 2, label, {
        fontFamily: 'Arial',
        fontSize: 16,
        color: '#ffffff',
      })
      .setOrigin(0.5);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => bg.setFillStyle(0x335577));
    bg.on('pointerout', () => bg.setFillStyle(0x223344));
    bg.on('pointerdown', onClick);
    txt.setInteractive({ useHandCursor: true });
    txt.on('pointerdown', onClick);
    return [bg, txt];
  }

  /**
   * Add or remove the host's "Start Game" button based on current host
   * status. Called from create() and again on every S2C_LOBBY_STATE so
   * host migration / fresh-round-after-end-of-round paths render the
   * button correctly.
   */
  private refreshHostButton(): void {
    const shouldShow = this.amHost();
    const isShowing = this.startButton.length > 0;
    if (shouldShow && !isShowing) {
      const { width, height } = this.scale.gameSize;
      this.startButton = this.makeButton(
        width / 2 + 40,
        height - 90,
        200,
        40,
        'Start Game',
        () => this.handleStart(),
      );
    } else if (!shouldShow && isShowing) {
      for (const o of this.startButton) o.destroy();
      this.startButton = [];
    }
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
