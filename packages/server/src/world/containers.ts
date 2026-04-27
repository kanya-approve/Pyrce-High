/**
 * Container seeding + per-match container instances.
 *
 * Containers exist statically on the map (their coordinates come from the
 * tilemap manifest). Contents are initialised at game start with a thematic
 * loot table per container kind (Knife Rack → knives, Refrigerator → soda
 * + first aid, etc.) — mirroring the spawn behaviour of `Containers.dm`.
 */

import type { ContainerPoint, InventoryState, ItemInstance } from '@pyrce/shared';
import { addItem } from '../inventory.js';
import { tilemap } from './tilemap.js';

export interface ContainerInstance {
  containerId: string;
  /** DM type path, e.g. `/obj/Containers_Stationed/Knife_Rack`. */
  kind: string;
  x: number;
  y: number;
  contents: ItemInstance[];
}

/** Loot tables. Quantity ranges interpreted inclusively. */
interface LootRule {
  itemId: string;
  /** Probability 0..1 for each "roll". */
  chance: number;
  /** Min/max units to drop on a successful roll. */
  min?: number;
  max?: number;
}

/**
 * Map container DM-type-paths to loot rules. Anything not matched gets the
 * default empty loot. Tweak as we add items / playtest.
 */
const LOOT: Array<{ match: RegExp; rules: LootRule[] }> = [
  {
    match: /Knife_Rack/i,
    rules: [{ itemId: 'knife', chance: 0.9, min: 1, max: 2 }],
  },
  {
    match: /Refrigerator/i,
    rules: [
      { itemId: 'soda', chance: 0.9, min: 1, max: 3 },
      { itemId: 'first_aid_kit', chance: 0.3 },
    ],
  },
  {
    match: /Bat_Bin/i,
    rules: [
      { itemId: 'wooden_bat', chance: 0.7 },
      { itemId: 'metal_bat', chance: 0.3 },
    ],
  },
  {
    match: /Tool_Box/i,
    rules: [
      { itemId: 'hammer', chance: 0.6 },
      { itemId: 'nails', chance: 0.5, min: 1, max: 3 },
      { itemId: 'tape', chance: 0.5 },
    ],
  },
  {
    match: /Nurses_Closet/i,
    rules: [
      { itemId: 'first_aid_kit', chance: 0.6 },
      { itemId: 'empty_syringe', chance: 0.5 },
      { itemId: 'super_regenerative', chance: 0.3 },
      { itemId: 'mild_sedative', chance: 0.3 },
      { itemId: 'cure_vial', chance: 0.2 },
    ],
  },
  {
    match: /Key_Locker/i,
    rules: [{ itemId: 'key_card', chance: 0.5 }],
  },
  {
    match: /Cabinet/i,
    rules: [
      { itemId: 'soda', chance: 0.4 },
      { itemId: 'pencil', chance: 0.4 },
      { itemId: 'paper_sheet', chance: 0.3, min: 1, max: 2 },
    ],
  },
  {
    match: /(Office_Desk|School_Desk)/i,
    rules: [
      { itemId: 'pencil', chance: 0.6 },
      { itemId: 'paper_sheet', chance: 0.5, min: 1, max: 3 },
      { itemId: 'yen', chance: 0.3, min: 50, max: 200 },
    ],
  },
  {
    match: /Teachers_Desk/i,
    rules: [
      { itemId: 'pencil', chance: 0.6 },
      { itemId: 'paper_sheet', chance: 0.5, min: 1, max: 3 },
      { itemId: 'school_computer', chance: 0.05 },
      { itemId: 'flashlight', chance: 0.2 },
    ],
  },
  {
    match: /Counter|Drawers/i,
    rules: [
      { itemId: 'tape', chance: 0.2 },
      { itemId: 'nails', chance: 0.2, min: 1, max: 2 },
      { itemId: 'flashlight', chance: 0.15 },
      { itemId: 'glow_stick', chance: 0.2 },
      { itemId: 'mystia_coin', chance: 0.3, min: 1, max: 3 },
    ],
  },
  {
    match: /Trash_Can/i,
    rules: [
      { itemId: 'yen', chance: 0.4, min: 25, max: 75 },
      { itemId: 'paper_sheet', chance: 0.3 },
    ],
  },
  {
    match: /Locker/i,
    rules: [
      { itemId: 'flashlight', chance: 0.2 },
      { itemId: 'wooden_bat', chance: 0.2 },
      { itemId: 'mop', chance: 0.15 },
      { itemId: 'tape', chance: 0.2 },
      // Lethal weapons in some lockers — Default.dmm has no Knife_Rack so
      // this is the easiest lethal source pre-M5 (when mode-driven spawn
      // tables override loot).
      { itemId: 'knife', chance: 0.15 },
      { itemId: 'metal_pipe', chance: 0.1 },
    ],
  },
  {
    match: /Book_Shelf/i,
    rules: [
      { itemId: 'paper_sheet', chance: 0.3, min: 1, max: 3 },
      { itemId: 'pencil', chance: 0.3 },
    ],
  },
  {
    match: /Storage_Container|Wooden_Box/i,
    rules: [
      { itemId: 'tape', chance: 0.3 },
      { itemId: 'nails', chance: 0.3, min: 1, max: 4 },
      { itemId: 'glow_stick', chance: 0.3 },
    ],
  },
  {
    match: /Oven/i,
    rules: [{ itemId: 'ladle', chance: 0.4 }],
  },
];

function newContainerId(point: ContainerPoint): string {
  return `c_${point.x}_${point.y}_${Math.floor(Math.random() * 0x10000).toString(16)}`;
}

function applyLoot(rules: LootRule[]): ItemInstance[] {
  // Use addItem on a throwaway InventoryState so stack-merging semantics
  // are reused. It's a trivially small allocation.
  const inv: InventoryState = {
    items: [],
    hotkeys: [null, null, null, null, null],
    equipped: null,
    weight: 0,
    weightCap: 999,
  };
  for (const rule of rules) {
    if (Math.random() >= rule.chance) continue;
    const min = rule.min ?? 1;
    const max = rule.max ?? min;
    const count = min + Math.floor(Math.random() * (max - min + 1));
    addItem(inv, rule.itemId, count);
  }
  return inv.items;
}

/**
 * Build the per-match container instances from the static tilemap manifest.
 * Called once when the match transitions Lobby → InGame.
 */
export function seedContainers(): { [containerId: string]: ContainerInstance } {
  const containers: { [containerId: string]: ContainerInstance } = {};
  for (const point of tilemap.raw.containers) {
    const inst: ContainerInstance = {
      containerId: newContainerId(point),
      kind: point.kind,
      x: point.x,
      y: point.y,
      contents: [],
    };
    for (const lootEntry of LOOT) {
      if (lootEntry.match.test(point.kind)) {
        inst.contents = applyLoot(lootEntry.rules);
        break;
      }
    }
    containers[inst.containerId] = inst;
  }
  return containers;
}
