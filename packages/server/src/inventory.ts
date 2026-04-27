/**
 * Pure inventory mutation helpers + crafting validation. These functions
 * mutate the supplied `InventoryState` in place (Nakama match state is
 * mutable by design) and recompute the cached `weight`.
 *
 * Stackable items (Yen, Mystia Coin) merge into existing stacks of the
 * same `itemId` on add, and split count-down on remove.
 */

import {
  type InventoryState,
  ITEMS,
  type ItemInstance,
  type ItemInstanceId,
  RECIPES_BY_ID,
  type RecipeDef,
} from '@pyrce/shared';

/**
 * Goja in Nakama supports `Math.random()` but no `crypto`. We accept that
 * instance ids are not cryptographically random — they only need to be
 * unique within a single match's lifetime, and a 96-bit space well
 * exceeds any plausible match's item count.
 */
export function newInstanceId(): ItemInstanceId {
  const part = () =>
    Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, '0');
  return `${part()}${part()}${part()}` as ItemInstanceId;
}

/**
 * Goja-on-Nakama gotcha: the match-state object is wrapped in a Go-side
 * proxy. **Top-level property assignment** propagates through (`pp.x = y`),
 * but **nested array / object mutation** is silently dropped (`pp.list.push(x)`,
 * `pp.obj.k = v`). So our inventory helpers MUST be pure: they take an
 * inventory + return a new one. Callers do `player.inventory = result.inv`
 * — that single assignment is what survives the proxy round-trip.
 */

export function computeWeight(items: ReadonlyArray<ItemInstance>): number {
  let w = 0;
  for (const it of items) {
    const def = ITEMS[it.itemId];
    if (def) w += def.weight * it.count;
  }
  return Math.round(w * 10) / 10;
}

export interface AddItemResult {
  inventory: InventoryState;
  instance: ItemInstance;
}

/**
 * Add an item. For stackables, merges into the first existing stack of the
 * same itemId. Returns the new inventory + the resulting instance (existing
 * for stack-merge, new for non-stack).
 */
export function addItem(
  inv: InventoryState,
  itemId: string,
  count: number,
  data?: Record<string, unknown>,
): AddItemResult | null {
  const def = ITEMS[itemId];
  if (!def) return null;
  if (def.stackable) {
    for (const it of inv.items) {
      if (it.itemId === itemId) {
        const merged: ItemInstance = { ...it, count: it.count + count };
        const newItems = inv.items.map((x) => (x.instanceId === it.instanceId ? merged : x));
        return {
          inventory: { ...inv, items: newItems, weight: computeWeight(newItems) },
          instance: merged,
        };
      }
    }
  }
  const inst: ItemInstance = {
    instanceId: newInstanceId(),
    itemId,
    count,
    ...(data ? { data } : {}),
  };
  const newItems = [...inv.items, inst];
  return {
    inventory: { ...inv, items: newItems, weight: computeWeight(newItems) },
    instance: inst,
  };
}

export interface RemoveItemResult {
  inventory: InventoryState;
  removed: ItemInstance;
}

/**
 * Remove a specific instance entirely. Returns the new inventory + the
 * removed instance. Also clears any hotkey slot pointing at it and
 * un-equips it if equipped.
 */
export function removeItem(
  inv: InventoryState,
  instanceId: ItemInstanceId,
): RemoveItemResult | null {
  const removed = inv.items.find((it) => it.instanceId === instanceId);
  if (!removed) return null;
  const newItems = inv.items.filter((it) => it.instanceId !== instanceId);
  const newHotkeys = inv.hotkeys.map((slot) =>
    slot === instanceId ? null : slot,
  ) as InventoryState['hotkeys'];
  return {
    inventory: {
      ...inv,
      items: newItems,
      hotkeys: newHotkeys,
      equipped: inv.equipped === instanceId ? null : inv.equipped,
      weight: computeWeight(newItems),
    },
    removed,
  };
}

export function findInstance(
  inv: InventoryState,
  instanceId: ItemInstanceId,
): ItemInstance | undefined {
  return inv.items.find((it) => it.instanceId === instanceId);
}

export function setHotkey(
  inv: InventoryState,
  slot: 1 | 2 | 3 | 4 | 5,
  instanceId: ItemInstanceId | null,
): InventoryState | null {
  if (instanceId !== null && !findInstance(inv, instanceId)) return null;
  const newHotkeys = inv.hotkeys.slice() as InventoryState['hotkeys'];
  newHotkeys[slot - 1] = instanceId;
  return { ...inv, hotkeys: newHotkeys };
}

export function setEquipped(
  inv: InventoryState,
  instanceId: ItemInstanceId | null,
): InventoryState | null {
  if (instanceId !== null && !findInstance(inv, instanceId)) return null;
  return { ...inv, equipped: instanceId };
}

// ---------- Crafting ----------

/**
 * Attempt to craft. Iterates the recipe's `inputs` and verifies each
 * required item id is present in sufficient quantity. On success, returns
 * the new inventory with the consumed instances removed + output added.
 */
export interface CraftSuccess {
  ok: true;
  recipe: RecipeDef;
  consumedInstanceIds: ItemInstanceId[];
  output: ItemInstance;
  inventory: InventoryState;
}
export interface CraftFailure {
  ok: false;
  recipe: RecipeDef | null;
  error: string;
}
export type CraftAttempt = CraftSuccess | CraftFailure;

export function craft(inv: InventoryState, recipeId: string): CraftAttempt {
  const recipe = RECIPES_BY_ID[recipeId];
  if (!recipe) {
    return { ok: false, recipe: null, error: 'unknown_recipe' };
  }

  const consume: ItemInstanceId[] = [];
  for (const [itemId, needCount] of Object.entries(recipe.inputs)) {
    let remaining = needCount;
    for (const it of inv.items) {
      if (it.itemId !== itemId) continue;
      if (consume.includes(it.instanceId)) continue;
      consume.push(it.instanceId);
      remaining -= it.count;
      if (remaining <= 0) break;
    }
    if (remaining > 0) {
      return { ok: false, recipe, error: `missing_${itemId}` };
    }
  }

  let next = inv;
  for (const id of consume) {
    const r = removeItem(next, id);
    if (!r) return { ok: false, recipe, error: `missing_${id}` };
    next = r.inventory;
  }
  const added = addItem(next, recipe.output, 1);
  if (!added) {
    return { ok: false, recipe, error: 'output_missing' };
  }
  return {
    ok: true,
    recipe,
    consumedInstanceIds: consume,
    output: added.instance,
    inventory: added.inventory,
  };
}
