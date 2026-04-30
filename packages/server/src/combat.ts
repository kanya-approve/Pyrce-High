/**
 * Combat resolver. Pure functions over PyrceMatchState that compute who
 * gets hit, by how much, and whether they die. The match handler wires
 * the broadcasts; this module owns the rules.
 */

import { DIRECTION_DELTAS, type Facing, ITEMS, type ItemDef } from '@pyrce/shared';
import { newInstanceId } from './inventory.js';
import type { Corpse, PlayerInGame, PyrceMatchState } from './matches/state.js';

/** Default unarmed weapon spec when nothing is equipped. */
const FISTS: NonNullable<ItemDef['weapon']> = (() => {
  const def = ITEMS.fists;
  return def?.weapon ?? { damage: 5, staminaCost: 2, range: 1, cooldownTicks: 9, lethal: false };
})();

export interface AttackResult {
  /** Did the swing happen at all (off-cooldown, alive, has stamina)? */
  swung: boolean;
  /** Hit a player? */
  hitUserId: string | null;
  damage: number;
  weaponName: string;
  /** Cooldown remaining in ticks if swing was rejected. */
  cooldownRemaining?: number;
  /** Did the hit kill the victim this swing? */
  killed: boolean;
  /** Corpse spawned on kill (server adds to state.corpses). */
  corpse?: Corpse;
  /** Outcome flavor for fx/log/announce: 'miss' / 'crit' / 'glance' / 'normal'. */
  outcome?: 'miss' | 'crit' | 'glance' | 'normal';
}

export function resolveAttack(
  state: PyrceMatchState,
  attacker: PlayerInGame,
  attackTick: number,
  facingOverride?: Facing,
): AttackResult {
  const result: AttackResult = {
    swung: false,
    hitUserId: null,
    damage: 0,
    weaponName: 'fists',
    killed: false,
  };
  if (!attacker.isAlive) return result;

  const equippedInst = attacker.inventory.equipped
    ? attacker.inventory.items.find((it) => it.instanceId === attacker.inventory.equipped)
    : null;
  const equippedDef = equippedInst ? ITEMS[equippedInst.itemId] : null;
  const weapon = equippedDef?.weapon ?? FISTS;
  const weaponName = equippedDef?.name ?? 'Fists';

  const elapsed = attackTick - attacker.lastAttackTickN;
  if (elapsed < weapon.cooldownTicks) {
    result.cooldownRemaining = weapon.cooldownTicks - elapsed;
    return result;
  }
  if (attacker.stamina < weapon.staminaCost) return result;

  result.swung = true;
  result.weaponName = weaponName;
  attacker.lastAttackTickN = attackTick;
  attacker.stamina = Math.max(0, attacker.stamina - weapon.staminaCost);

  const dir = facingOverride ?? attacker.facing;
  const delta = DIRECTION_DELTAS[dir];
  if (!delta) return result;

  // Walk from 1..weapon.range tiles in the attack direction; first live
  // player along that line takes the hit.
  let victim: PlayerInGame | null = null;
  for (let step = 1; step <= weapon.range; step++) {
    const tx = attacker.x + delta.dx * step;
    const ty = attacker.y + delta.dy * step;
    for (const userId in state.players) {
      const p = state.players[userId];
      if (!p || p === attacker || !p.isAlive) continue;
      if (p.x === tx && p.y === ty) {
        victim = p;
        break;
      }
    }
    if (victim) break;
  }
  if (!victim) return result;

  result.hitUserId = victim.userId;
  // DM Weapons Attacks.dm: per-swing combat roll.
  //   * 10% miss (rand 1-10 == 1) — only for awake, non-KO'd targets
  //   * 25% face-to-face crit (+rand 1-3 dmg) when attacker's dir is the
  //     reciprocal of victim's facing (head-on encounter)
  //   * 25% behind-target glance (-rand 1-2 dmg) when victim is fleeing in
  //     the attacker's facing dir (same-dir step in front)
  const victimKO = (state.koUntilTick?.[victim.userId] ?? 0) > attackTick;
  let dmg = weapon.damage;
  let outcome: 'miss' | 'crit' | 'glance' | 'normal' = 'normal';
  if (!victimKO) {
    if (Math.floor(Math.random() * 10) === 0) {
      dmg = 0;
      outcome = 'miss';
    } else if (isOpposite(dir, victim.facing) && Math.floor(Math.random() * 4) === 0) {
      dmg += 1 + Math.floor(Math.random() * 3);
      outcome = 'crit';
    } else if (
      victim.facing === dir &&
      victim.x === attacker.x + delta.dx &&
      victim.y === attacker.y + delta.dy &&
      Math.floor(Math.random() * 4) === 0
    ) {
      dmg = Math.max(1, dmg - (1 + Math.floor(Math.random() * 2)));
      outcome = 'glance';
    }
  }
  // Mystic Eyes: Nanaya wielding Nanatsu-Yoru with glasses removed swaps
  // the standard knife damage for a "lines of death" roll — 1% chance of
  // instant kill (999 dmg), otherwise rand(1, 33) chip damage. The
  // glasses-off check reads `glasses_case`'s instance-data `on=false`.
  if (outcome !== 'miss' && weaponName === 'Nanatsu-Yoru' && attacker.roleId === 'vampire') {
    const glasses = attacker.inventory.items.find((it) => it.itemId === 'glasses_case');
    const glassesOff = glasses?.data?.['on'] === false;
    if (glassesOff) {
      if (Math.floor(Math.random() * 100) === 0) {
        dmg = 999;
      } else {
        dmg = 1 + Math.floor(Math.random() * 33);
      }
    }
  }
  result.outcome = outcome;
  result.damage = dmg;
  victim.hp = Math.max(0, victim.hp - dmg);
  // Bloody bump: any non-miss hit drips a little blood on victim too.
  if (dmg > 0) {
    victim.bloody = Math.min(8, (victim.bloody ?? 0) + 1);
  }

  if (victim.hp === 0) {
    if (weapon.lethal) {
      // Kill: mark dead, spawn corpse, transfer inventory to corpse.
      const corpse: Corpse = {
        corpseId: newInstanceId(),
        victimUserId: victim.userId,
        victimUsername: victim.username,
        victimRealName: victim.realName,
        killerUserId: attacker.userId,
        cause: weaponName,
        x: victim.x,
        y: victim.y,
        contents: victim.inventory.items.slice(),
        discovered: false,
        discoveredByUserId: null,
      };
      victim.isAlive = false;
      victim.isWatching = true;
      // Whole-object replacement (Goja proxy quirk — see inventory.ts).
      victim.inventory = {
        items: [],
        hotkeys: [null, null, null, null, null],
        equipped: null,
        weight: 0,
        weightCap: victim.inventory.weightCap,
      };
      result.killed = true;
      result.corpse = corpse;

      // Attacker accumulates blood on every kill — visible to onlookers via
      // the public sprite tier. Caps at 8 (DM `bloody==6` flips to "very").
      attacker.bloody = Math.min(8, (attacker.bloody ?? 0) + 1);

      // Mark the killer's equipped weapon bloody if the atlas has a bloody
      // variant for that itemId — purely cosmetic. Goja proxy: replace the
      // whole instance and the items array, don't mutate in place.
      if (equippedInst) {
        const bloodied = {
          ...equippedInst,
          data: { ...(equippedInst.data ?? {}), bloody: true },
        };
        attacker.inventory = {
          ...attacker.inventory,
          items: attacker.inventory.items.map((it) =>
            it.instanceId === equippedInst.instanceId ? bloodied : it,
          ),
        };
      }
    } else {
      // Non-lethal hits cap HP at 1 instead of killing — DM's KO behaviour.
      victim.hp = 1;
    }
  }

  return result;
}

/**
 * Stamina regen tick. Called once per match loop. Restores 1 stamina per
 * tick (so 100 over 10s at 10 Hz). DM uses a similar passive regen.
 */
export function regenStamina(state: PyrceMatchState): void {
  for (const userId in state.players) {
    const p = state.players[userId];
    if (!p || !p.isAlive) continue;
    if (p.stamina < p.maxStamina) {
      p.stamina = Math.min(p.maxStamina, p.stamina + 1);
    }
  }
}

/**
 * Body discovery: any alive player not already known to be the killer who
 * walks within Chebyshev≤1 of an undiscovered corpse marks it discovered.
 * Returns the list of corpses newly discovered this tick (for the match
 * handler to broadcast).
 */
export function checkBodyDiscoveries(state: PyrceMatchState): Corpse[] {
  const newlyDiscovered: Corpse[] = [];
  for (const cid in state.corpses) {
    const c = state.corpses[cid];
    if (!c || c.discovered) continue;
    for (const uid in state.players) {
      const p = state.players[uid];
      if (!p || !p.isAlive) continue;
      if (p.userId === c.killerUserId) continue;
      const d = Math.max(Math.abs(p.x - c.x), Math.abs(p.y - c.y));
      if (d <= 1) {
        c.discovered = true;
        c.discoveredByUserId = p.userId;
        newlyDiscovered.push(c);
        break;
      }
    }
  }
  return newlyDiscovered;
}

/** Two facings are opposite if they sit on the same axis pointing the other way. */
function isOpposite(a: Facing, b: Facing): boolean {
  return (
    (a === 'N' && b === 'S') ||
    (a === 'S' && b === 'N') ||
    (a === 'E' && b === 'W') ||
    (a === 'W' && b === 'E')
  );
}
