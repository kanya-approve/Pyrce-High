import type { Presence } from '@heroiclabs/nakama-js';
import { Scene } from 'phaser';
import type { NakamaMatchClient } from '../../net/matchClient';

interface LobbyData {
  matchId: string;
  presences: Presence[];
}

/**
 * Joined-lobby waiting room. Shows the player list (updated via match
 * presence events). Host has a Start button (no-op until M5 wires the mode
 * engine). Anyone can Leave back to the browser.
 */
export class Lobby extends Scene {
  private match!: NakamaMatchClient;
  private matchId!: string;
  private presences = new Map<string, Presence>();
  private playerListText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;

  constructor() {
    super('Lobby');
  }

  init(data: LobbyData): void {
    this.matchId = data.matchId;
    this.presences.clear();
    for (const p of data.presences ?? []) {
      this.presences.set(p.user_id, p);
    }
  }

  create(): void {
    this.match = this.game.registry.get('match') as NakamaMatchClient;
    const { width, height } = this.scale.gameSize;

    this.add
      .text(width / 2, 50, `Lobby: ${this.matchId.slice(0, 24)}…`, {
        fontFamily: 'Arial Black',
        fontSize: 22,
        color: '#ffffff',
      })
      .setOrigin(0.5, 0);

    this.add
      .text(width / 2, 90, 'Waiting for players…', {
        fontFamily: 'Arial',
        fontSize: 14,
        color: '#888888',
      })
      .setOrigin(0.5, 0);

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
    this.makeButton(width / 2 + 40, height - 90, 200, 40, 'Start Game (M5+)', () =>
      this.handleStart(),
    );

    this.match.onPresenceChange((ev) => {
      for (const p of ev.joins ?? []) this.presences.set(p.user_id, p);
      for (const p of ev.leaves ?? []) this.presences.delete(p.user_id);
      this.renderPlayers();
    });

    this.renderPlayers();
  }

  shutdown(): void {
    this.match.onPresenceChange(() => {});
  }

  private renderPlayers(): void {
    if (this.presences.size === 0) {
      this.playerListText.setText('(no players yet)');
      return;
    }
    const lines: string[] = [];
    let i = 1;
    for (const p of this.presences.values()) {
      const tag = p.user_id === this.match.userId ? ' (you)' : '';
      lines.push(`${String(i).padStart(2, ' ')}.  ${p.username}${tag}`);
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

  private handleStart(): void {
    this.statusText.setText('Start is a no-op until M5 (mode engine + Normal mode).');
  }

  private makeButton(
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    onClick: () => void,
  ): void {
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
  }
}
