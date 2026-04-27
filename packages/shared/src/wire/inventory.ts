/**
 * Wire payloads for inventory + container interactions. All operations are
 * server-validated; the client only sends intent.
 */
import type { ItemInstanceId } from '../ids.js';
import type { InventoryState, ItemInstance } from '../state/inventory.js';

// ---------- Client → Server ----------

export interface C2SInvPickup {
  /** Which ground item to grab. The server validates proximity. */
  groundItemId: string;
}

export interface C2SInvDrop {
  instanceId: ItemInstanceId;
}

export interface C2SInvEquip {
  /** instanceId to equip; null reverts to fists. */
  instanceId: ItemInstanceId | null;
}

export interface C2SInvUse {
  instanceId: ItemInstanceId;
}

export interface C2SInvSetHotkey {
  /** Slot 1..5. */
  slot: 1 | 2 | 3 | 4 | 5;
  instanceId: ItemInstanceId | null;
}

export interface C2SInvCraft {
  recipeId: string;
}

export interface C2SContainerLook {
  /** Tile to inspect. Server resolves to the container at this tile (proximity-checked). */
  x: number;
  y: number;
}

export interface C2SContainerTake {
  containerId: string;
  instanceId: ItemInstanceId;
}

export interface C2SContainerPut {
  containerId: string;
  instanceId: ItemInstanceId;
}

// ---------- Server → Client ----------

export interface S2CInvFull {
  inventory: InventoryState;
}

export interface S2CInvDelta {
  /** Updated items (added or stack-changed); send the canonical instance per id. */
  upserted?: ItemInstance[];
  /** Removed instance ids. */
  removed?: ItemInstanceId[];
  /** Updated hotkey slot, if changed. */
  hotkeys?: InventoryState['hotkeys'];
  /** Updated equipped, if changed. */
  equipped?: ItemInstanceId | null;
  /** Updated weight, if changed. */
  weight?: number;
}

export interface PublicGroundItem {
  groundItemId: string;
  itemId: string;
  count: number;
  x: number;
  y: number;
}

export interface S2CWorldGroundItems {
  /** Full set of ground items on the map. Sent on InGame entry + after big changes. */
  items: PublicGroundItem[];
}

export interface S2CWorldGroundItemDelta {
  upserted?: PublicGroundItem[];
  removed?: string[]; // groundItemId
}

export interface PublicContainer {
  containerId: string;
  kind: string;
  x: number;
  y: number;
  /** Only items the requesting client is allowed to see; for v1 that's all of them. */
  contents: ItemInstance[];
}

export interface S2CContainerContents {
  container: PublicContainer;
}

export interface S2CCraftResult {
  ok: boolean;
  recipeId: string;
  error?: string;
  /** Output instanceId on success. */
  instanceId?: ItemInstanceId;
}
