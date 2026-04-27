/**
 * Inventory state replicated to the owning player only. Other players see at
 * most an `equippedItemId` on the public player snapshot (M4+).
 *
 * Hotkey slots reference items by `instanceId`; equipping an item not in
 * `items[]` is a server-side no-op.
 */
import type { ItemInstanceId } from '../ids.js';

export interface ItemInstance {
  instanceId: ItemInstanceId;
  itemId: string;
  /** For stackables (Yen, Mystia Coin); always 1 for non-stackable items. */
  count: number;
  /** Per-instance free-form data (Death Note pages, syringe filler, written paper text). */
  data?: Record<string, unknown>;
}

export interface InventoryState {
  items: ItemInstance[];
  /** Five hotkey slots (1..5), referencing `instanceId` or null. */
  hotkeys: [
    ItemInstanceId | null,
    ItemInstanceId | null,
    ItemInstanceId | null,
    ItemInstanceId | null,
    ItemInstanceId | null,
  ];
  /** instanceId of the equipped weapon, or null for fists. */
  equipped: ItemInstanceId | null;
  /** Cached weight sum. Server recomputes on every mutation. */
  weight: number;
  /** Soft cap from DM Vars.dm: `weight > 20 -> frozen`. */
  weightCap: number;
}

export const INITIAL_INVENTORY: InventoryState = {
  items: [],
  hotkeys: [null, null, null, null, null],
  equipped: null,
  weight: 0,
  weightCap: 20,
};

/**
 * Public-view: what other clients see about an opponent's inventory.
 * For now just the equipped item id (so the killer's knife is visible);
 * full hidden-state discipline lands when roles ship in M5.
 */
export interface PublicInventoryView {
  equippedItemId: string | null;
}
