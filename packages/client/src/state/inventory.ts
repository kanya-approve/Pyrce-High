import type { InventoryState, ItemInstance, S2CInvDelta, S2CInvFull } from '@pyrce/shared';

/**
 * Client-side mirror of the server's authoritative inventory. Mutated by
 * S2C_INV_FULL / S2C_INV_DELTA broadcasts; the GameWorld scene reads from
 * here for hotkey activations + container puts.
 */
export type ClientInventory = InventoryState;

const INITIAL: ClientInventory = {
  items: [],
  hotkeys: [null, null, null, null, null],
  equipped: null,
  weight: 0,
  weightCap: 20,
};

export function newClientInventory(): ClientInventory {
  return {
    items: [],
    hotkeys: [null, null, null, null, null],
    equipped: null,
    weight: 0,
    weightCap: INITIAL.weightCap,
  };
}

export function applyFull(inv: ClientInventory, msg: S2CInvFull): void {
  inv.items = msg.inventory.items.slice();
  inv.hotkeys = [...msg.inventory.hotkeys] as ClientInventory['hotkeys'];
  inv.equipped = msg.inventory.equipped;
  inv.weight = msg.inventory.weight;
  inv.weightCap = msg.inventory.weightCap;
}

export function applyDelta(inv: ClientInventory, msg: S2CInvDelta): void {
  if (msg.removed) {
    const removed = new Set(msg.removed);
    inv.items = inv.items.filter((it) => !removed.has(it.instanceId));
  }
  if (msg.upserted) {
    const byId = new Map<string, ItemInstance>(inv.items.map((it) => [it.instanceId, it]));
    for (const u of msg.upserted) byId.set(u.instanceId, u);
    inv.items = Array.from(byId.values());
  }
  if (msg.hotkeys !== undefined) {
    inv.hotkeys = [...msg.hotkeys] as ClientInventory['hotkeys'];
  }
  if (msg.equipped !== undefined) {
    inv.equipped = msg.equipped;
  }
  if (msg.weight !== undefined) {
    inv.weight = msg.weight;
  }
}
