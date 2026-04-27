/**
 * Ground items: items lying on the floor between player inventories and
 * containers. Live in match state as `MatchState.world.groundItems`.
 *
 * On player drop -> add a ground item at the player's tile.
 * On player pickup at proximity -> remove the ground item, hand to inventory.
 */

import type { ItemInstance, ItemInstanceId } from '@pyrce/shared';

export interface GroundItem {
  groundItemId: string;
  itemId: string;
  count: number;
  x: number;
  y: number;
  /** Per-instance free-form data — preserved across drop / pickup. */
  data?: Record<string, unknown>;
  /**
   * Original inventory instance id. Reused on pickup so the same instance
   * keeps its identity across drop/pickup cycles. Could be regenerated;
   * stable ids make smoke-test bookkeeping easier.
   */
  instanceId: ItemInstanceId;
}

export function newGroundItemId(): string {
  const part = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  return `g_${part()}${part()}${part()}`;
}

export function fromInstance(inst: ItemInstance, x: number, y: number): GroundItem {
  return {
    groundItemId: newGroundItemId(),
    itemId: inst.itemId,
    count: inst.count,
    x,
    y,
    instanceId: inst.instanceId,
    ...(inst.data ? { data: inst.data } : {}),
  };
}
