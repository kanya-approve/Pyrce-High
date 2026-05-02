import { MatchPhase, OpCode, type S2CGameResult, type S2CPhaseChange } from '@pyrce/shared';
import { Scene } from 'phaser';
import type { NakamaMatchClient } from '../../net/matchClient';

interface EndSceneData {
  result: S2CGameResult;
  matchId: string;
}

/**
 * Round-over screen: winner banner + role reveal list. The server auto-
 * resets the match back to Lobby phase ~10s after the round ends; when
 * we receive that S2C_PHASE_CHANGE we hop straight back to the Lobby
 * scene so connected players don't have to click anything.
 */
export class EndScene extends Scene {
  private result!: S2CGameResult;
  private matchId!: string;
  private offMatchData: (() => void) | null = null;

  constructor() {
    super('EndScene');
  }

  init(data: EndSceneData): void {
    this.result = data.result;
    this.matchId = data.matchId;
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
      ? `Winners: ${this.result.winners.map((w) => `${w.realName} (${w.roleId})`).join(', ')}`
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
      return `${String(i + 1).padStart(2)}. ${tag} ${r.realName.padEnd(22)}  ${r.roleId}${winner}`;
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

    this.add
      .text(width / 2, height - 60, 'returning to lobby…', {
        fontFamily: 'Arial',
        fontSize: 14,
        color: '#888888',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(2);

    // Server fires S2C_PHASE_CHANGE → Lobby a few seconds after end-of-round.
    // Hop back to the Lobby scene as soon as it lands.
    const match = this.game.registry.get('match') as NakamaMatchClient | undefined;
    if (match) {
      this.offMatchData = match.onMatchData((msg) => {
        if (msg.op_code !== OpCode.S2C_PHASE_CHANGE) return;
        try {
          const data =
            typeof msg.data === 'string' ? msg.data : new TextDecoder().decode(msg.data);
          const payload = JSON.parse(data) as S2CPhaseChange;
          if (payload.phase === MatchPhase.Lobby) {
            this.scene.start('Lobby', { matchId: this.matchId, presences: [], hostUserId: null });
          }
        } catch {
          // ignore malformed
        }
      });
    }
  }

  shutdown(): void {
    this.offMatchData?.();
    this.offMatchData = null;
  }

}
