import { ATLAS_JSON, ATLAS_KEY, ATLAS_PNG } from '@pyrce/shared';
import { Scene } from 'phaser';

/**
 * Initial scene. The Nakama connect handshake happens in `src/main.ts` before
 * Phaser starts; by the time this scene runs, the `NakamaMatchClient` is on
 * the game registry under the 'match' key. We just show a tiny status screen
 * and transition to the lobby browser.
 */
export class Boot extends Scene {
  private statusText?: Phaser.GameObjects.Text;

  constructor() {
    super('Boot');
  }

  preload(): void {
    // Atlas + turf icon lookup produced by tools/dmi-extract — Vite serves
    // them as static files under /public/atlases.
    this.load.atlas(ATLAS_KEY, ATLAS_PNG, ATLAS_JSON);
    this.load.json('turf-icons', '/atlases/turf-icons.json');
  }

  create(): void {
    const { width, height } = this.scale.gameSize;
    this.add
      .text(width / 2, height / 2 - 40, 'PYRCE HIGH', {
        fontFamily: 'Arial Black',
        fontSize: 56,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 6,
      })
      .setOrigin(0.5);

    this.statusText = this.add
      .text(width / 2, height / 2 + 30, 'Connecting…', {
        fontFamily: 'Arial',
        fontSize: 22,
        color: '#cccccc',
      })
      .setOrigin(0.5);

    if (this.game.registry.get('match')) {
      this.advance();
    } else {
      window.addEventListener('pyrce:connected', () => this.advance(), { once: true });
      window.addEventListener(
        'pyrce:connect-error',
        (ev) => {
          const detail = (ev as CustomEvent).detail;
          this.statusText?.setText(`Connect failed: ${String(detail)}`);
        },
        { once: true },
      );
    }
  }

  private advance(): void {
    this.scene.start('LobbyBrowser');
  }
}
