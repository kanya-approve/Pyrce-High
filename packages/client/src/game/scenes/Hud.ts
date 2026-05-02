import { ATLAS_KEY, ITEM_SPRITES, ITEMS } from '@pyrce/shared';
import { Scene } from 'phaser';
import type { ClientGameInfo } from '../../state/game';
import type { ClientInventory } from '../../state/inventory';

interface HudData {
  inventory: () => ClientInventory;
  game: () => ClientGameInfo;
}

interface HotkeySlot {
  bg: Phaser.GameObjects.Rectangle;
  border: Phaser.GameObjects.Rectangle;
  icon: Phaser.GameObjects.Image;
  count: Phaser.GameObjects.Text;
  numLabel: Phaser.GameObjects.Text;
}

/**
 * Minimal HUD overlay. Mirrors the original BYOND `ingame.dmf` skin: a
 * single bottom strip with five item slots, plus a compact top-left
 * vitals/role pill. Status messages flow into the chat overlay rather
 * than floating banners — same approach the original game took.
 */
export class Hud extends Scene {
  private getInventory!: () => ClientInventory;
  private getGame!: () => ClientGameInfo;
  private hotkeySlots: HotkeySlot[] = [];
  private hpFill!: Phaser.GameObjects.Rectangle;
  private hpText!: Phaser.GameObjects.Text;
  private vitalsText!: Phaser.GameObjects.Text;
  /** Last rendered signature; skip the redraw when nothing changed. */
  private lastVitalsSig = '';
  private lastInvSig = '';

  constructor() {
    super('Hud');
  }

  init(data: HudData): void {
    this.getInventory = data.inventory;
    this.getGame = data.game;
  }

  create(): void {
    const { width, height } = this.scale.gameSize;
    this.buildVitals();
    this.buildHotkeyBar(width, height);

    this.events.on('inv:refresh', () => this.renderInventory());
    this.events.on('inv:notify', (msg: string) => this.flash(msg));
    this.events.on('game:refresh', () => this.renderVitals());
    this.events.on('hud:vitals', () => this.renderVitals());
    this.events.on(
      'hud:status',
      (s: { ko: boolean; bleeding: boolean; frozen: boolean; infected: boolean }) =>
        this.renderStatusToChat(s),
    );

    this.renderInventory();
    this.renderVitals();

    // Defensive re-render: covers the race where ROLE_ASSIGNED / INV_FULL
    // arrive before our create() finished wiring listeners. Cheap because
    // both renderers early-return when their state signature is unchanged.
    this.time.addEvent({
      delay: 500,
      loop: true,
      callback: () => {
        this.renderVitals();
        this.renderInventory();
      },
    });
  }

  // ---------- layout ----------

  private buildVitals(): void {
    const x = 12;
    const y = 12;
    const barW = 140;
    const barH = 10;
    this.add
      .rectangle(x, y, barW, barH, 0x330000)
      .setOrigin(0, 0)
      .setStrokeStyle(1, 0x000000)
      .setScrollFactor(0)
      .setDepth(1000);
    this.hpFill = this.add
      .rectangle(x, y, barW, barH, 0xcc3333)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(1000);
    this.hpText = this.add
      .text(x + barW / 2, y + barH / 2, '', {
        fontFamily: 'Courier New',
        fontSize: 10,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(1001);
    this.vitalsText = this.add
      .text(x, y + barH + 4, '', {
        fontFamily: 'Arial Black',
        fontSize: 13,
        color: '#ffe066',
        backgroundColor: '#000000aa',
        padding: { left: 6, right: 6, top: 2, bottom: 2 },
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(1001);
  }

  /**
   * Bottom strip: 5 slot buttons across the full width, mirroring the
   * `ingame` window in Skinned.dmf (size 384x46 — five 64x46 buttons).
   * Slot N is hotkey N.
   */
  private buildHotkeyBar(width: number, height: number): void {
    const slotH = 46;
    const slotW = Math.floor(width / 5);
    const y = height - slotH;
    // Initialize each icon with a known-good frame so Phaser's texture
    // pipeline doesn't NPE later when we setFrame() to a real item icon.
    const initialFrame = this.textures.get(ATLAS_KEY).getFrameNames()[0] ?? '__BASE';
    for (let i = 0; i < 5; i++) {
      const x = i * slotW;
      const bg = this.add
        .rectangle(x, y, slotW, slotH, 0x000000, 0.7)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(1000)
        .setInteractive({ useHandCursor: true });
      const border = this.add
        .rectangle(x, y, slotW, slotH)
        .setOrigin(0, 0)
        .setStrokeStyle(1, 0x445566)
        .setScrollFactor(0)
        .setDepth(1001);
      const icon = this.add
        .image(x + slotW / 2, y + slotH / 2 + 4, ATLAS_KEY, initialFrame)
        .setOrigin(0.5, 0.5)
        .setScrollFactor(0)
        .setDepth(1001)
        .setVisible(false);
      const numLabel = this.add
        .text(x + 6, y + 4, String(i + 1), {
          fontFamily: 'Arial Black',
          fontSize: 12,
          color: '#aaccff',
          stroke: '#000000',
          strokeThickness: 3,
        })
        .setScrollFactor(0)
        .setDepth(1002);
      const count = this.add
        .text(x + slotW - 6, y + slotH - 6, '', {
          fontFamily: 'Arial Black',
          fontSize: 11,
          color: '#ffe066',
          stroke: '#000000',
          strokeThickness: 3,
        })
        .setOrigin(1, 1)
        .setScrollFactor(0)
        .setDepth(1002);
      bg.on('pointerdown', () => this.scene.get('GameWorld').events.emit('hud:hotkey', i + 1));
      this.hotkeySlots.push({ bg, border, icon, count, numLabel });
    }
  }

  // ---------- renderers ----------

  private renderVitals(): void {
    if (!this.hpFill || !this.hpFill.scene) return;
    const g = this.getGame();
    const sig = `${g.hp}/${g.maxHp}|${g.role?.roleName ?? ''}|${g.clock?.gameHour ?? ''}${g.clock?.ampm ?? ''}`;
    if (sig === this.lastVitalsSig) return;
    this.lastVitalsSig = sig;
    const hpRatio = g.maxHp > 0 ? Math.max(0, Math.min(1, g.hp / g.maxHp)) : 0;
    this.hpFill.setSize(140 * hpRatio, 10);
    const hpColor = hpRatio > 0.66 ? 0x55ff55 : hpRatio > 0.33 ? 0xffcc44 : 0xff5555;
    this.hpFill.setFillStyle(hpColor);
    this.hpText.setText(`${g.hp} / ${g.maxHp}`);
    const parts: string[] = [];
    if (g.role) parts.push(g.role.roleName);
    if (g.clock) {
      parts.push(`${String(g.clock.gameHour).padStart(2, '0')}:00 ${g.clock.ampm}`);
    }
    if (parts.length === 0) parts.push('(no role yet)');
    this.vitalsText.setText(parts.join(' · '));
  }

  private renderInventory(): void {
    const inv = this.getInventory();
    const sig = `${inv.equipped ?? ''}|${inv.hotkeys.join(',')}|${inv.items.map((i) => `${i.instanceId}:${i.itemId}:${i.count}`).join('|')}`;
    if (sig === this.lastInvSig) return;
    this.lastInvSig = sig;
    const atlas = this.textures.get(ATLAS_KEY);
    for (let i = 0; i < 5; i++) {
      const slot = this.hotkeySlots[i];
      if (!slot || !slot.bg.scene) continue;
      const ref = inv.hotkeys[i];
      const it = ref ? inv.items.find((x) => x.instanceId === ref) : null;
      const def = it ? ITEMS[it.itemId] : null;
      const isEquipped = it ? it.instanceId === inv.equipped : false;
      slot.border.setStrokeStyle(isEquipped ? 2 : 1, isEquipped ? 0xffe066 : 0x445566);
      const frame = it ? ITEM_SPRITES[it.itemId] : undefined;
      if (frame && atlas.has(frame)) {
        slot.icon.setFrame(frame).setVisible(true).setAlpha(1).setScale(1);
      } else {
        slot.icon.setVisible(false);
      }
      slot.count.setText(it && it.count > 1 ? `×${it.count}` : '');
      slot.numLabel.setText(def ? `${i + 1}·${def.name.slice(0, 8)}` : String(i + 1));
    }
  }

  /** Route quick info into the chat overlay so the screen stays clean. */
  private flash(msg: string): void {
    this.scene.get('ChatOverlay').events.emit('chat:system', msg);
  }

  private renderStatusToChat(s: {
    ko: boolean;
    bleeding: boolean;
    frozen: boolean;
    infected: boolean;
  }): void {
    const tags: string[] = [];
    if (s.ko) tags.push('KO');
    if (s.frozen) tags.push('frozen');
    if (s.bleeding) tags.push('bleeding');
    if (s.infected) tags.push('infected');
    if (tags.length === 0) return;
    this.scene.get('ChatOverlay').events.emit('chat:system', `status: ${tags.join(', ')}`);
  }
}
