import { ATLAS_KEY, ITEM_SPRITES, ITEMS, type ItemDef } from '@pyrce/shared';
import { Scene } from 'phaser';
import type { ClientGameInfo } from '../../state/game';
import type { ClientInventory } from '../../state/inventory';

interface HudData {
  inventory: () => ClientInventory;
  game: () => ClientGameInfo;
}

const SLOT = 36; // hotkey slot tile size
const SLOT_GAP = 6;

interface HotkeySlot {
  bg: Phaser.GameObjects.Rectangle;
  border: Phaser.GameObjects.Rectangle;
  icon: Phaser.GameObjects.Image;
  count: Phaser.GameObjects.Text;
  numLabel: Phaser.GameObjects.Text;
}

/**
 * Persistent HUD overlay rendered on top of `GameWorld`. Reads the
 * player's local inventory mirror via the function passed in at launch
 * time and re-renders on demand (cheap; tiny string operations).
 *
 * Layout (mirrors the original BYOND skin):
 *   bottom-center: 5-slot hotkey bar with item icons + slot numbers
 *   bottom-right: weight + full inventory list (text fallback)
 *   top-left:     HP bar + stamina bar + heart icon
 *   top-center:   role banner + clock
 */
export class Hud extends Scene {
  private getInventory!: () => ClientInventory;
  private getGame!: () => ClientGameInfo;
  private invText!: Phaser.GameObjects.Text;
  private roleText!: Phaser.GameObjects.Text;
  private clockText!: Phaser.GameObjects.Text;
  private notif!: Phaser.GameObjects.Text;
  private notifTimer?: Phaser.Time.TimerEvent;
  private hotkeySlots: HotkeySlot[] = [];
  private hpFill!: Phaser.GameObjects.Rectangle;
  private hpText!: Phaser.GameObjects.Text;
  private staFill!: Phaser.GameObjects.Rectangle;

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
    this.buildRoleBanner(width);
    this.buildHotkeyBar(width, height);
    this.buildInventoryPanel(width);
    this.buildHotkeyHint(width, height);

    this.notif = this.add
      .text(width / 2, 80, '', {
        fontFamily: 'Arial',
        fontSize: 14,
        color: '#ffffaa',
        backgroundColor: '#000000aa',
        padding: { left: 8, right: 8, top: 4, bottom: 4 },
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(1001)
      .setVisible(false);

    this.events.on('inv:refresh', () => this.renderInventory());
    this.events.on('inv:notify', (msg: string) => this.flash(msg));
    this.events.on('game:refresh', () => this.renderGame());
    this.events.on('hud:vitals', () => this.renderVitals());

    this.renderInventory();
    this.renderGame();
    this.renderVitals();
  }

  // ---------- layout builders ----------

  /** Top-left HP + stamina bars, with a heart icon next to the HP bar. */
  private buildVitals(): void {
    const x0 = 12;
    const y0 = 12;
    const barWidth = 140;
    const barHeight = 12;

    if (
      this.textures.exists(ATLAS_KEY) &&
      this.textures.get(ATLAS_KEY).has('root/healthhud/_/S/0')
    ) {
      this.add
        .image(x0 + 8, y0 + barHeight / 2, ATLAS_KEY, 'root/healthhud/_/S/0')
        .setOrigin(0.5, 0.5)
        .setScrollFactor(0)
        .setDepth(1000);
    }
    this.add
      .rectangle(x0 + 22, y0, barWidth, barHeight, 0x330000)
      .setOrigin(0, 0)
      .setStrokeStyle(1, 0x000000)
      .setScrollFactor(0)
      .setDepth(1000);
    this.hpFill = this.add
      .rectangle(x0 + 22, y0, barWidth, barHeight, 0xcc3333)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(1000);
    this.hpText = this.add
      .text(x0 + 22 + barWidth / 2, y0 + barHeight / 2, '', {
        fontFamily: 'Courier New',
        fontSize: 11,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(1001);

    const yStam = y0 + barHeight + 4;
    this.add
      .text(x0, yStam, 'STA', {
        fontFamily: 'Courier New',
        fontSize: 10,
        color: '#88ccff',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(1000);
    this.add
      .rectangle(x0 + 22, yStam, barWidth, 8, 0x002233)
      .setOrigin(0, 0)
      .setStrokeStyle(1, 0x000000)
      .setScrollFactor(0)
      .setDepth(1000);
    this.staFill = this.add
      .rectangle(x0 + 22, yStam, barWidth, 8, 0x3399ff)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(1000);
  }

  private buildRoleBanner(width: number): void {
    this.roleText = this.add
      .text(width / 2, 12, '', {
        fontFamily: 'Arial Black',
        fontSize: 14,
        color: '#ffd866',
        backgroundColor: '#000000aa',
        padding: { left: 8, right: 8, top: 4, bottom: 4 },
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(1000);

    this.clockText = this.add
      .text(width / 2, 38, '', {
        fontFamily: 'Courier New',
        fontSize: 14,
        color: '#aaaaaa',
        backgroundColor: '#000000aa',
        padding: { left: 8, right: 8, top: 2, bottom: 2 },
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(1000);
  }

  /** Bottom-center 5-slot icon bar. Slots are reused; only contents update. */
  private buildHotkeyBar(width: number, height: number): void {
    const totalWidth = SLOT * 5 + SLOT_GAP * 4;
    const startX = (width - totalWidth) / 2;
    const y = height - SLOT - 36;
    for (let i = 0; i < 5; i++) {
      const x = startX + i * (SLOT + SLOT_GAP);
      const bg = this.add
        .rectangle(x, y, SLOT, SLOT, 0x000000, 0.55)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(1000);
      const border = this.add
        .rectangle(x, y, SLOT, SLOT)
        .setOrigin(0, 0)
        .setStrokeStyle(2, 0x666666)
        .setScrollFactor(0)
        .setDepth(1001);
      const icon = this.add
        .image(x + SLOT / 2, y + SLOT / 2, ATLAS_KEY)
        .setOrigin(0.5, 0.5)
        .setScrollFactor(0)
        .setDepth(1001)
        .setVisible(false);
      const numLabel = this.add
        .text(x + 3, y + 1, String(i + 1), {
          fontFamily: 'Arial Black',
          fontSize: 11,
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 3,
        })
        .setScrollFactor(0)
        .setDepth(1002);
      const count = this.add
        .text(x + SLOT - 3, y + SLOT - 3, '', {
          fontFamily: 'Arial Black',
          fontSize: 10,
          color: '#ffe066',
          stroke: '#000000',
          strokeThickness: 3,
        })
        .setOrigin(1, 1)
        .setScrollFactor(0)
        .setDepth(1002);
      this.hotkeySlots.push({ bg, border, icon, count, numLabel });
    }
  }

  /** Compact text-mode inventory + weight. Bottom-right corner. */
  private buildInventoryPanel(width: number): void {
    this.invText = this.add
      .text(width - 12, 12, '', {
        fontFamily: 'Courier New',
        fontSize: 12,
        color: '#dddddd',
        backgroundColor: '#000000aa',
        padding: { left: 6, right: 6, top: 4, bottom: 4 },
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(1000);
  }

  private buildHotkeyHint(width: number, height: number): void {
    this.add
      .text(
        width / 2,
        height - 12,
        'WASD/arrows · E interact · F attack · 1-5 hotkey · G drop · C craft Spear · T chat',
        {
          fontFamily: 'Arial',
          fontSize: 11,
          color: '#888888',
          backgroundColor: '#000000aa',
          padding: { left: 8, right: 8, top: 3, bottom: 3 },
        },
      )
      .setOrigin(0.5, 1)
      .setScrollFactor(0)
      .setDepth(1000);
  }

  // ---------- renderers ----------

  private renderGame(): void {
    const g = this.getGame();
    this.roleText.setText(g.role ? `You are: ${g.role.roleName}` : '');
    this.clockText.setText(
      g.clock
        ? `${String(g.clock.gameHour).padStart(2, '0')}:00 ${g.clock.ampm}  · ${g.clock.hoursLeft.toFixed(1)}h to dawn`
        : '',
    );
  }

  private renderVitals(): void {
    const g = this.getGame();
    const hpRatio = g.maxHp > 0 ? Math.max(0, Math.min(1, g.hp / g.maxHp)) : 0;
    this.hpFill.setSize(140 * hpRatio, 12);
    const hpColor = hpRatio > 0.66 ? 0x55ff55 : hpRatio > 0.33 ? 0xffcc44 : 0xff5555;
    this.hpFill.setFillStyle(hpColor);
    this.hpText.setText(`${g.hp} / ${g.maxHp}`);
    const staRatio = g.maxStamina > 0 ? Math.max(0, Math.min(1, g.stamina / g.maxStamina)) : 0;
    this.staFill.setSize(140 * staRatio, 8);
  }

  private flash(msg: string): void {
    this.notif.setText(msg).setVisible(true);
    this.notifTimer?.remove();
    this.notifTimer = this.time.delayedCall(2200, () => this.notif.setVisible(false));
  }

  private renderInventory(): void {
    const inv = this.getInventory();
    const atlas = this.textures.get(ATLAS_KEY);

    // Hotkey bar slots.
    for (let i = 0; i < 5; i++) {
      const slot = this.hotkeySlots[i];
      if (!slot) continue;
      const ref = inv.hotkeys[i];
      const it = ref ? inv.items.find((x) => x.instanceId === ref) : null;
      const def = it ? ITEMS[it.itemId] : null;
      const isEquipped = it ? it.instanceId === inv.equipped : false;
      slot.border.setStrokeStyle(2, isEquipped ? 0xffe066 : 0x666666);
      const frame = it ? ITEM_SPRITES[it.itemId] : undefined;
      if (frame && atlas.has(frame)) {
        slot.icon.setFrame(frame).setVisible(true);
      } else {
        slot.icon.setVisible(false);
      }
      slot.count.setText(it && it.count > 1 ? `×${it.count}` : '');
      // Tooltip-ish: append item name to the slot number when populated.
      slot.numLabel.setText(def ? `${i + 1} ${def.name.slice(0, 8)}` : String(i + 1));
    }

    // Compact text inventory (right side).
    const lines: string[] = [`weight ${inv.weight.toFixed(1)} / ${inv.weightCap}`];
    const equippedItem = inv.equipped ? inv.items.find((i) => i.instanceId === inv.equipped) : null;
    const equippedDef = equippedItem ? ITEMS[equippedItem.itemId] : null;
    lines.push(`equipped: ${equippedDef?.name ?? '(fists)'}`);
    if (inv.items.length === 0) {
      lines.push('(empty pack)');
    } else {
      lines.push('— inventory —');
      for (const it of inv.items) {
        const def: ItemDef | undefined = ITEMS[it.itemId];
        const stack = it.count > 1 ? ` ×${it.count}` : '';
        const equippedTag = it.instanceId === inv.equipped ? ' [E]' : '';
        lines.push(`${def?.name ?? it.itemId}${stack}${equippedTag}`);
      }
    }
    this.invText.setText(lines.join('\n'));
  }
}
