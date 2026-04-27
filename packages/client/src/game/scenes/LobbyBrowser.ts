import type { MatchListing } from '@pyrce/shared';
import { Scene } from 'phaser';
import type { NakamaMatchClient } from '../../net/matchClient';

const POLL_INTERVAL_MS = 3000;

/**
 * Lists open matches via the listMatches RPC, polls every 3s, and offers a
 * "Create Lobby" button. Clicking a row joins the match (`socket.joinMatch`)
 * then transitions to the Lobby scene with the match id in scene data.
 */
export class LobbyBrowser extends Scene {
  private match!: NakamaMatchClient;
  private listText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private rowZones: Phaser.GameObjects.Zone[] = [];
  private listings: MatchListing[] = [];
  private pollEvent?: Phaser.Time.TimerEvent;
  private busy = false;

  constructor() {
    super('LobbyBrowser');
  }

  create(): void {
    this.match = this.game.registry.get('match') as NakamaMatchClient;
    const { width } = this.scale.gameSize;

    this.add
      .text(width / 2, 50, 'Pyrce High — Lobby Browser', {
        fontFamily: 'Arial Black',
        fontSize: 32,
        color: '#ffffff',
      })
      .setOrigin(0.5, 0);

    this.add
      .text(width / 2, 95, `signed in as ${this.match.username || this.match.userId.slice(0, 8)}`, {
        fontFamily: 'Arial',
        fontSize: 14,
        color: '#888888',
      })
      .setOrigin(0.5, 0);

    this.makeButton(width / 2 - 110, 140, 220, 40, '+ Create Lobby', () => this.handleCreate());
    this.makeButton(width / 2 - 110, 190, 220, 40, '↻ Refresh', () => this.refresh());

    this.listText = this.add.text(60, 250, 'Loading matches…', {
      fontFamily: 'Courier New',
      fontSize: 16,
      color: '#dddddd',
    });

    this.statusText = this.add
      .text(width / 2, this.scale.gameSize.height - 30, '', {
        fontFamily: 'Arial',
        fontSize: 14,
        color: '#ff8080',
      })
      .setOrigin(0.5);

    this.refresh();
    this.pollEvent = this.time.addEvent({
      delay: POLL_INTERVAL_MS,
      loop: true,
      callback: () => {
        if (!this.busy) this.refresh();
      },
    });
  }

  shutdown(): void {
    this.pollEvent?.remove();
    for (const z of this.rowZones) z.destroy();
    this.rowZones = [];
  }

  private async refresh(): Promise<void> {
    this.busy = true;
    try {
      this.listings = await this.match.listMatches(20);
      this.renderList();
      this.statusText.setText('');
    } catch (err) {
      console.error('[pyrce] listMatches failed', err);
      this.statusText.setText(`listMatches failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private renderList(): void {
    for (const z of this.rowZones) z.destroy();
    this.rowZones = [];

    if (this.listings.length === 0) {
      this.listText.setText('No open lobbies. Create one to start.');
      return;
    }

    const lines = this.listings
      .map(
        (m, i) =>
          `${String(i + 1).padStart(2, ' ')}.  ${m.label.name.padEnd(30, ' ')}  ${m.label.phase.padEnd(8, ' ')}  ${m.size}/22`,
      )
      .join('\n');
    this.listText.setText(lines);

    const lineHeight = 22;
    for (let i = 0; i < this.listings.length; i++) {
      const y = 250 + i * lineHeight;
      const zone = this.add
        .zone(60, y, this.scale.gameSize.width - 120, lineHeight)
        .setOrigin(0, 0)
        .setInteractive({ useHandCursor: true });
      zone.on('pointerover', () => this.listText.setColor('#ffffaa'));
      zone.on('pointerout', () => this.listText.setColor('#dddddd'));
      zone.on('pointerdown', () => {
        const listing = this.listings[i];
        if (listing) this.handleJoin(listing.matchId);
      });
      this.rowZones.push(zone);
    }
  }

  private async handleCreate(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.statusText.setText('Creating lobby…').setColor('#aaaaaa');
    try {
      const created = await this.match.createMatch();
      const m = await this.match.joinMatch(created.matchId);
      // Nakama's joinMatch returns {match_id, label, self, authoritative} — the
      // joining user's own presence is in `self`. Other players arrive via
      // onmatchpresence events.
      const initialPresences = m.self ? [m.self] : [];
      this.scene.start('Lobby', {
        matchId: created.matchId,
        presences: initialPresences,
        hostUserId: created.label.hostUserId ?? this.match.userId,
      });
    } catch (err) {
      console.error('[pyrce] createMatch failed', err);
      this.statusText.setText(`Create failed: ${(err as Error).message}`).setColor('#ff8080');
    } finally {
      this.busy = false;
    }
  }

  private async handleJoin(matchId: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.statusText.setText('Joining…').setColor('#aaaaaa');
    try {
      const listing = this.listings.find((l) => l.matchId === matchId);
      const m = await this.match.joinMatch(matchId);
      const initialPresences = m.self ? [m.self] : [];
      this.scene.start('Lobby', {
        matchId,
        presences: initialPresences,
        hostUserId: listing?.label.hostUserId ?? null,
      });
    } catch (err) {
      console.error('[pyrce] joinMatch failed', err);
      this.statusText.setText(`Join failed: ${(err as Error).message}`).setColor('#ff8080');
    } finally {
      this.busy = false;
    }
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
