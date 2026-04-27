import { ITEMS, type ItemDef } from '@pyrce/shared';
import { Scene } from 'phaser';
import type { ClientInventory } from '../../state/inventory';

interface HudData {
  inventory: () => ClientInventory;
}

/**
 * Persistent HUD overlay rendered on top of `GameWorld`. Reads the
 * player's local inventory mirror via the function passed in at launch
 * time and re-renders on demand (cheap; tiny string operations).
 */
export class Hud extends Scene {
  private getInventory!: () => ClientInventory;
  private invText!: Phaser.GameObjects.Text;
  private notif!: Phaser.GameObjects.Text;
  private notifTimer?: Phaser.Time.TimerEvent;

  constructor() {
    super('Hud');
  }

  init(data: HudData): void {
    this.getInventory = data.inventory;
  }

  create(): void {
    const { width, height } = this.scale.gameSize;

    this.invText = this.add
      .text(width - 12, 12, '', {
        fontFamily: 'Courier New',
        fontSize: 13,
        color: '#ffffff',
        backgroundColor: '#000000aa',
        padding: { left: 6, right: 6, top: 4, bottom: 4 },
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(1000);

    this.add
      .text(
        width / 2,
        height - 12,
        'WASD/arrows · E interact · 1-5 hotkey · G drop equipped · C craft Spear · I refresh',
        {
          fontFamily: 'Arial',
          fontSize: 12,
          color: '#aaaaaa',
          backgroundColor: '#000000aa',
          padding: { left: 8, right: 8, top: 4, bottom: 4 },
        },
      )
      .setOrigin(0.5, 1)
      .setScrollFactor(0)
      .setDepth(1000);

    this.notif = this.add
      .text(width / 2, 60, '', {
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

    this.events.on('inv:refresh', () => this.render());
    this.events.on('inv:notify', (msg: string) => this.flash(msg));

    this.render();
  }

  private flash(msg: string): void {
    this.notif.setText(msg).setVisible(true);
    this.notifTimer?.remove();
    this.notifTimer = this.time.delayedCall(2200, () => this.notif.setVisible(false));
  }

  private render(): void {
    const inv = this.getInventory();
    const lines: string[] = [];
    lines.push(`weight ${inv.weight.toFixed(1)} / ${inv.weightCap}`);
    const equippedItem = inv.equipped ? inv.items.find((i) => i.instanceId === inv.equipped) : null;
    const equippedDef = equippedItem ? ITEMS[equippedItem.itemId] : null;
    lines.push(`equipped: ${equippedDef?.name ?? '(fists)'}`);
    lines.push('hotkeys:');
    for (let s = 0; s < 5; s++) {
      const ref = inv.hotkeys[s];
      if (!ref) {
        lines.push(`  ${s + 1}. (empty)`);
        continue;
      }
      const it = inv.items.find((i) => i.instanceId === ref);
      const def = it ? ITEMS[it.itemId] : null;
      lines.push(`  ${s + 1}. ${def?.name ?? '?'}`);
    }
    lines.push('');
    lines.push('inventory:');
    if (inv.items.length === 0) {
      lines.push('  (empty)');
    } else {
      for (const it of inv.items) {
        const def: ItemDef | undefined = ITEMS[it.itemId];
        const stack = it.count > 1 ? ` ×${it.count}` : '';
        const equippedTag = it.instanceId === inv.equipped ? ' [E]' : '';
        lines.push(`  ${def?.name ?? it.itemId}${stack}${equippedTag}`);
      }
    }
    this.invText.setText(lines.join('\n'));
  }
}
