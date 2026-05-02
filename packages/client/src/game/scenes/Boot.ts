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
    // Atlas + turf icon lookup live as static files under /public/atlases.
    this.load.atlas(ATLAS_KEY, ATLAS_PNG, ATLAS_JSON);
    this.load.json('turf-icons', '/atlases/turf-icons.json');

    // SFX bank — file names match server-side broadcastFxSound keys.
    const sfx: Array<[string, string]> = [
      ['knife_stab', '/audio/knife_stab.opus'],
      ['axe_door', '/audio/axe_door.opus'],
      ['billhook', '/audio/billhook.opus'],
      ['taser', '/audio/taser.opus'],
      ['bat_hit', '/audio/bat_hit.opus'],
      ['punch', '/audio/punch.opus'],
      ['body_fall', '/audio/body_fall.opus'],
      ['doormetal', '/audio/doormetal.opus'],
      ['door_lock', '/audio/door_lock.opus'],
      ['footsteps', '/audio/footsteps.opus'],
      ['smallexplosion', '/audio/smallexplosion.opus'],
      ['writing', '/audio/writing.opus'],
      ['page_turn_1', '/audio/page_turn_1.opus'],
      ['nailing', '/audio/nailing.opus'],
      ['howling', '/audio/howling.opus'],
      ['alarm', '/audio/alarm.opus'],
      // Per-mode background music. Played in GameWorld; varies by mode.
      ['music.normal', '/audio/title.opus'],
      ['music.ghost', '/audio/title_ghost.opus'],
      ['music.witch', '/audio/title_witch.opus'],
      ['music.vampire', '/audio/title_Vampire.opus'],
      ['music.death_note_classic', '/audio/title_shin.opus'],
      ['music.secret', '/audio/titlesecret.opus'],
      ['music.doppelganger', '/audio/Title_DG.opus'],
    ];
    for (const [key, path] of sfx) this.load.audio(key, path);
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
