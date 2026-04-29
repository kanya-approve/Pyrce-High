/**
 * Mode engine. Pure-ish helpers that drive role assignment, item grants,
 * win-condition evaluation, and the in-game clock. The match handler
 * wires the broadcasts; this module owns the rules.
 *
 * Mode-specific imperative logic lives in `modeScripts/` (referenced by
 * `GameModeDef.scriptId`); v1 only has Normal which doesn't need a
 * script.
 */

import {
  type GameModeDef,
  type ItemGrant,
  ROLES,
  type RoleAssignment,
  type RoleId,
  type RoleReveal,
  type WinCondition,
} from '@pyrce/shared';
import { addItem, setEquipped, setHotkey } from './inventory.js';
import type { PlayerInGame, PyrceMatchState } from './matches/state.js';

// ---------- Role assignment ----------

/**
 * Distribute role ids across the players in `state`. Order is taken from
 * `state.players` insertion order (which is presence-join order). Players
 * are assigned in random order so the host doesn't always become role #1.
 */
export function assignRoles(state: PyrceMatchState, def: GameModeDef): void {
  const players = Object.values(state.players);
  if (players.length === 0) return;

  // Shuffle player order so assignment is uniform-random.
  const pool = shuffle(players);

  for (const assignment of def.setup.roles) {
    if (assignment.minPlayers && players.length < assignment.minPlayers) continue;
    if (assignment.probability !== undefined && Math.random() >= assignment.probability) continue;

    let needed: number;
    if (assignment.count === 'fillRemaining') {
      needed = pool.length;
    } else {
      needed = Math.min(assignment.count, pool.length);
    }
    for (let i = 0; i < needed; i++) {
      const target = pool.shift();
      if (!target) break;
      target.roleId = assignment.roleId;
      const role = ROLES[assignment.roleId];
      target.maxHp = role.baseHp;
      target.hp = role.baseHp;
      target.maxStamina = role.baseStamina;
      target.stamina = role.baseStamina;
      // M5 leaves realName=username; M5.x can wire char-create overrides.
    }
    if (pool.length === 0) break;
  }

  // Anyone remaining defaults to civilian. (Shouldn't happen if a recipe
  // includes `fillRemaining`, but defensive.)
  for (const p of pool) {
    p.roleId = 'civilian';
  }
}

export function applyItemGrants(
  state: PyrceMatchState,
  def: GameModeDef,
  logger?: nkruntime.Logger,
): void {
  const items = def.setup?.items;
  logger?.info('applyItemGrants: items=%s', JSON.stringify(items));
  if (!items) return;
  for (const grant of items) {
    logger?.info('  grant=%s', JSON.stringify(grant));
    for (const userId in state.players) {
      const p = state.players[userId];
      logger?.info('    consider user=%s role=%s', userId, p?.roleId ?? 'none');
      if (!p || p.roleId !== grant.roleId) continue;
      grantItemTo(p, grant, logger);
      logger?.info('    after grant, items=%d', p.inventory.items.length);
    }
  }
}

function grantItemTo(player: PlayerInGame, grant: ItemGrant, logger?: nkruntime.Logger): void {
  logger?.info('      grantItemTo: itemId=%s', grant.itemId);
  const r = addItem(player.inventory, grant.itemId, grant.count ?? 1);
  if (!r) {
    logger?.info('      addItem returned: null');
    return;
  }
  let inv = r.inventory;
  if (grant.equip) {
    const e = setEquipped(inv, r.instance.instanceId);
    if (e) inv = e;
  }
  if (grant.hotkey) {
    const h = setHotkey(inv, grant.hotkey, r.instance.instanceId);
    if (h) inv = h;
  }
  // Goja proxy quirk: only top-level property assignment on the player
  // object propagates back to the live state. See `inventory.ts` header.
  player.inventory = inv;
  logger?.info('      added %s, items now=%d', r.instance.itemId, inv.items.length);
}

// ---------- Clock ----------

/**
 * Total in-game minutes per real second. The plan calls for 12 game-hours
 * (6 PM → 6 AM) over ~14 IRL minutes. 12 * 60 = 720 game-min over
 * 14 * 60 = 840 IRL sec → ~0.857 game-min per IRL sec, or ~1.167 IRL sec
 * per game-min.
 */
export const GAME_MINUTES_PER_IRL_SECOND = 720 / (14 * 60);

/** Game starts at 6:00 PM expressed as 18:00 in 24-hour minutes-from-midnight. */
export const GAME_START_TOTAL_MINUTES = 18 * 60;
/** Game ends at 6:00 AM the next day = 18:00 + 12h = 30:00 = 1800 min. */
export const GAME_END_TOTAL_MINUTES = GAME_START_TOTAL_MINUTES + 12 * 60;

export interface InGameClock {
  /** Server tick at which the round started. */
  startedAtTickN: number;
  /** Last broadcast game-minute, so we don't spam clock ticks within the same minute. */
  lastBroadcastMinute: number;
}

export function newClock(startedAtTickN: number): InGameClock {
  return { startedAtTickN, lastBroadcastMinute: -1 };
}

/**
 * Compute the current in-game time given a server tick. Returns 24-hour
 * minutes from midnight (e.g. 18:30 PM → 1110, 6:00 AM next day → 1800
 * which clients display as 6:00 AM).
 */
export function totalGameMinutes(
  clock: InGameClock,
  currentTickN: number,
  tickRateHz: number,
): number {
  const elapsedSec = Math.max(0, currentTickN - clock.startedAtTickN) / tickRateHz;
  return GAME_START_TOTAL_MINUTES + elapsedSec * GAME_MINUTES_PER_IRL_SECOND;
}

export function formatGameClock(totalMinutes: number): {
  hour12: number;
  minute: number;
  ampm: 'AM' | 'PM';
  hoursLeft: number;
} {
  const totalMin = Math.floor(totalMinutes);
  const hour24 = Math.floor(totalMin / 60) % 24;
  const minute = totalMin % 60;
  const ampm: 'AM' | 'PM' = hour24 >= 12 && hour24 < 24 ? 'PM' : 'AM';
  // Hour 18 (6 PM) → 6, hour 6 → 6, etc.
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  // Special-case the "6 AM the next day" boundary: at totalMin >= 1800 the
  // hour rolled past midnight; ampm needs to read AM not PM.
  const corrected: 'AM' | 'PM' = totalMin >= 24 * 60 ? 'AM' : ampm;
  const hoursLeft = Math.max(0, (GAME_END_TOTAL_MINUTES - totalMin) / 60);
  return { hour12, minute, ampm: corrected, hoursLeft };
}

// ---------- Win conditions ----------

export interface WinResult {
  reason: string;
  summary: string;
  winners: PlayerInGame[];
}

export function evaluateWinConditions(
  state: PyrceMatchState,
  def: GameModeDef,
  gameTimeMinutes: number,
): WinResult | null {
  for (const cond of def.winConditions) {
    const r = evaluateOne(state, cond, gameTimeMinutes);
    if (r) return r;
  }
  return null;
}

function evaluateOne(
  state: PyrceMatchState,
  cond: WinCondition,
  gameTimeMinutes: number,
): WinResult | null {
  switch (cond.type) {
    case 'roleEliminated':
      return evaluateRoleEliminated(state, cond);
    case 'lastFactionStanding':
      return evaluateLastFactionStanding(state, cond);
    case 'timeUp':
      return evaluateTimeUp(state, cond, gameTimeMinutes);
    default: {
      const _: never = cond;
      void _;
      return null;
    }
  }
}

function evaluateRoleEliminated(
  state: PyrceMatchState,
  cond: Extract<WinCondition, { type: 'roleEliminated' }>,
): WinResult | null {
  for (const userId in state.players) {
    const p = state.players[userId];
    if (p?.isAlive && p.roleId === cond.roleId) return null;
  }
  const winners: PlayerInGame[] = [];
  for (const userId in state.players) {
    const p = state.players[userId];
    if (p && ROLES[p.roleId].allegiance === cond.winningAllegiance) winners.push(p);
  }
  return {
    reason: 'role_eliminated',
    summary: `${ROLES[cond.roleId].name} eliminated — ${cond.winningAllegiance} wins.`,
    winners,
  };
}

function evaluateLastFactionStanding(
  state: PyrceMatchState,
  _cond: Extract<WinCondition, { type: 'lastFactionStanding' }>,
): WinResult | null {
  const buckets: Record<string, PlayerInGame[]> = { town: [], killer: [], neutral: [] };
  for (const userId in state.players) {
    const p = state.players[userId];
    if (!p) continue;
    // Escaped non-killer players count toward their faction even though
    // they're flagged !isAlive — they've survived and should win the round.
    if (!p.isAlive && !p.hasEscaped) continue;
    const a = ROLES[p.roleId].allegiance;
    buckets[a]?.push(p);
  }
  const aliveAllegiances = Object.entries(buckets).filter(([, ps]) => ps.length > 0);
  if (aliveAllegiances.length === 0) {
    // Total wipe — draw.
    return { reason: 'all_dead', summary: 'Everyone has perished.', winners: [] };
  }
  if (aliveAllegiances.length === 1) {
    const [allegiance, winners] = aliveAllegiances[0] ?? ['', []];
    return {
      reason: 'last_faction_standing',
      summary: `Only ${allegiance} survives.`,
      winners: winners as PlayerInGame[],
    };
  }
  return null;
}

function evaluateTimeUp(
  state: PyrceMatchState,
  cond: Extract<WinCondition, { type: 'timeUp' }>,
  gameTimeMinutes: number,
): WinResult | null {
  // Translate cond.gameHour + ampm into 24-hour-from-midnight + the day
  // rollover (since the round starts at 6 PM and ends 6 AM the next day).
  let endHour24 = cond.gameHour % 12;
  if (cond.ampm === 'PM') endHour24 += 12;
  // If the configured end is "6 AM" (hour < 12 AM-side) it must be on the
  // next day, so add 24h.
  if (endHour24 < 12) endHour24 += 24;
  const endMinutes = endHour24 * 60;
  if (gameTimeMinutes < endMinutes) return null;

  const winners: PlayerInGame[] = [];
  if (cond.winningAllegiance === 'survivors') {
    for (const userId in state.players) {
      const p = state.players[userId];
      if (p && (p.isAlive || p.hasEscaped)) winners.push(p);
    }
  } else {
    for (const userId in state.players) {
      const p = state.players[userId];
      if (p && ROLES[p.roleId].allegiance === cond.winningAllegiance) winners.push(p);
    }
  }
  return {
    reason: 'time_up',
    summary: 'Sunrise. The lockdown lifts.',
    winners,
  };
}

// ---------- Reveal helpers ----------

export function buildReveals(state: PyrceMatchState): RoleReveal[] {
  const out: RoleReveal[] = [];
  for (const userId in state.players) {
    const p = state.players[userId];
    if (!p) continue;
    out.push({
      userId: p.userId,
      username: p.username,
      roleId: p.roleId as RoleId,
      isAlive: p.isAlive,
    });
  }
  return out;
}

// ---------- helpers ----------

function shuffle<T>(input: T[]): T[] {
  const arr = input.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}
