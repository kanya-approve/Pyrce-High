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

export function recomputeWeight(inv: InventoryState): void {
  let w = 0;
  for (const it of inv.items) {
    const def = ITEMS[it.itemId];
    if (def) w += def.weight * it.count;
  }
  inv.weight = Math.round(w * 10) / 10;
}

/**
 * Add an item to the inventory. For stackables, merges into the first
 * existing stack of the same itemId. Returns the resulting instance id
 * (existing for stack-merge, new for non-stack).
 */
export function addItem(
  inv: InventoryState,
  itemId: string,
  count: number,
  data?: Record<string, unknown>,
): ItemInstance | null {
  const def = ITEMS[itemId];
  if (!def) return null;
  if (def.stackable) {
    for (const it of inv.items) {
      if (it.itemId === itemId) {
        it.count += count;
        recomputeWeight(inv);
        return it;
      }
    }
  }
  const inst: ItemInstance = {
    instanceId: newInstanceId(),
    itemId,
    count,
    ...(data ? { data } : {}),
  };
  inv.items.push(inst);
  recomputeWeight(inv);
  return inst;
}

/**
 * Remove a specific instance entirely. Returns the removed instance, or
 * null if not found. Also clears any hotkey slot pointing at it and
 * un-equips it if equipped.
 */
export function removeItem(inv: InventoryState, instanceId: ItemInstanceId): ItemInstance | null {
  const idx = inv.items.findIndex((it) => it.instanceId === instanceId);
  if (idx === -1) return null;
  const removed = inv.items[idx];
  if (!removed) return null;
  inv.items.splice(idx, 1);
  for (let i = 0; i < inv.hotkeys.length; i++) {
    if (inv.hotkeys[i] === instanceId) inv.hotkeys[i] = null;
  }
  if (inv.equipped === instanceId) inv.equipped = null;
  recomputeWeight(inv);
  return removed;
}

/**
 * Decrement a stackable item's count by `amount`. If count drops to 0,
 * removes the instance entirely.
 */
export function decrementStack(
  inv: InventoryState,
  instanceId: ItemInstanceId,
  amount: number,
): ItemInstance | null {
  const it = inv.items.find((x) => x.instanceId === instanceId);
  if (!it) return null;
  it.count -= amount;
  if (it.count <= 0) {
    return removeItem(inv, instanceId);
  }
  recomputeWeight(inv);
  return it;
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
): boolean {
  if (instanceId !== null && !findInstance(inv, instanceId)) return false;
  inv.hotkeys[slot - 1] = instanceId;
  return true;
}

export function setEquipped(inv: InventoryState, instanceId: ItemInstanceId | null): boolean {
  if (instanceId === null) {
    inv.equipped = null;
    return true;
  }
  if (!findInstance(inv, instanceId)) return false;
  inv.equipped = instanceId;
  return true;
}

// ---------- Crafting ----------

export interface CraftAttempt {
  ok: boolean;
  recipe: RecipeDef | null;
  /** Resolved instance ids consumed (for atomic rollback if needed). */
  consumedInstanceIds: ItemInstanceId[];
  output: ItemInstance | null;
  error?: string;
}

/**
 * Attempt to craft. Iterates the recipe's `inputs` and verifies each
 * required item id is present in sufficient quantity (across stacks for
 * stackable items, across distinct instances for non-stackable). On
 * success, removes the consumed instances and adds the output.
 */
export function craft(inv: InventoryState, recipeId: string): CraftAttempt {
  const recipe = RECIPES_BY_ID[recipeId];
  if (!recipe) {
    return {
      ok: false,
      recipe: null,
      consumedInstanceIds: [],
      output: null,
      error: 'unknown_recipe',
    };
  }

  // First pass: choose which instances we'll consume.
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
      return {
        ok: false,
        recipe,
        consumedInstanceIds: [],
        output: null,
        error: `missing_${itemId}`,
      };
    }
  }

  // Second pass: actually consume + add output.
  for (const id of consume) removeItem(inv, id);
  const output = addItem(inv, recipe.output, 1);
  if (!output) {
    return {
      ok: false,
      recipe,
      consumedInstanceIds: consume,
      output: null,
      error: 'output_missing',
    };
  }
  return { ok: true, recipe, consumedInstanceIds: consume, output };
}
