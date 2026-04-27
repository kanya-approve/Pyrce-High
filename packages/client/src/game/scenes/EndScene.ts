import type { S2CGameResult } from '@pyrce/shared';
import { Scene } from 'phaser';

interface EndSceneData {
  result: S2CGameResult;
}

/**
 * Round-over screen: winner banner + role reveal list + return-to-lobby
 * button. Launched by GameWorld on `S2C_GAME_RESULT` and shuts the prior
 * GameWorld + Hud scenes down.
 */
export class EndScene extends Scene {
  private result!: S2CGameResult;

  constructor() {
    super('EndScene');
  }

  init(data: EndSceneData): void {
    this.result = data.result;
  }

  create(): void {
    const { width, height } = this.scale.gameSize;

    this.add
      .rectangle(0, 0, width, height, 0x000000, 0.85)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(1);

    this.add
      .text(width / 2, 80, 'Round over', {
        fontFamily: 'Arial Black',
        fontSize: 36,
        color: '#ffffff',
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(2);

    this.add
      .text(width / 2, 130, this.result.summary, {
        fontFamily: 'Arial',
        fontSize: 18,
        color: '#aaaaaa',
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(2);

    const winnerLine = this.result.winners.length
      ? `Winners: ${this.result.winners.map((w) => `${w.username} (${w.roleId})`).join(', ')}`
      : 'No winners.';
    this.add
      .text(width / 2, 165, winnerLine, {
        fontFamily: 'Arial',
        fontSize: 16,
        color: '#88ff88',
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(2);

    this.add
      .text(width / 2, 215, 'Role reveal', {
        fontFamily: 'Arial Black',
        fontSize: 18,
        color: '#ffffff',
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(2);

    const lines: string[] = this.result.reveals.map((r, i) => {
      const tag = r.isAlive ? ' ' : '†';
      const winner = this.result.winners.find((w) => w.userId === r.userId) ? ' ★' : '';
      return `${String(i + 1).padStart(2)}. ${tag} ${r.username.padEnd(16)}  ${r.roleId}${winner}`;
    });
    this.add
      .text(width / 2, 250, lines.join('\n'), {
        fontFamily: 'Courier New',
        fontSize: 16,
        color: '#dddddd',
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(2);

    this.makeButton(width / 2 - 110, height - 90, 220, 44, 'Return to lobby browser', () => {
      this.scene.start('LobbyBrowser');
    });
  }

  private makeButton(
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    onClick: () => void,
  ): void {
    const bg = this.add
      .rectangle(x, y, w, h, 0x223344)
      .setOrigin(0, 0)
      .setStrokeStyle(1, 0x88aaff)
      .setDepth(2);
    const txt = this.add
      .text(x + w / 2, y + h / 2, label, { fontFamily: 'Arial', fontSize: 16, color: '#ffffff' })
      .setOrigin(0.5)
      .setDepth(2);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerover', () => bg.setFillStyle(0x335577));
    bg.on('pointerout', () => bg.setFillStyle(0x223344));
    bg.on('pointerdown', onClick);
    txt.setInteractive({ useHandCursor: true });
    txt.on('pointerdown', onClick);
  }
}
