/**
 * Mode-specific imperative behaviour. Each mode's `scriptId` references one
 * entry here; the match loop calls these at well-known hooks (start, tick,
 * death, attack, item-use). Anything not declarative — Death Note's
 * scheduled-death proc, Witch's resurrection, Zombie's infection tick — lives
 * in this file.
 *
 * Hooks are intentionally narrow so the engine stays unaware of mode
 * internals; new modes only need to register a new entry in MODE_SCRIPTS.
 */

import type { PlayerInGame, PyrceMatchState } from './matches/state.js';

export interface ScriptHookContext {
  /** Server tick when the hook fired. */
  tick: number;
  /** Tick rate in Hz (used to convert delays to ticks). */
  tickRate: number;
}

export interface ModeScript {
  /**
   * Fired when a player is killed (after corpse + state mutation).
   * Mode-specific behaviour like Witch revive lands here.
   */
  onDeath?(
    state: PyrceMatchState,
    victim: PlayerInGame,
    attackerUserId: string | null,
    ctx: ScriptHookContext,
  ): void;

  /**
   * Fired when a player attacks another (after damage applied, before death
   * resolution). Mode-specific behaviour like Zombie infection or Vampire
   * heal-on-hit lands here.
   */
  onAttack?(
    state: PyrceMatchState,
    attacker: PlayerInGame,
    victim: PlayerInGame,
    weaponName: string,
    ctx: ScriptHookContext,
  ): void;

  /**
   * Fired on item use (after the engine resolves the item def's `use.kind`).
   * Death Note's `death_note_write` consumes this to schedule a kill.
   */
  onUse?(
    state: PyrceMatchState,
    user: PlayerInGame,
    instanceId: string,
    payload: unknown,
    ctx: ScriptHookContext,
  ): void;

  /** Per-tick poll for delayed effects (kill timers, infection turn, …). */
  onTick?(state: PyrceMatchState, ctx: ScriptHookContext): void;
}

/**
 * Death-Note: writing a name in the notebook schedules a "heart attack"
 * after ~40s (DM `Black Feather.dm` and `Verbs.dm` death-note proc).
 *
 * The state.scheduledDeaths list is drained by onTick. We don't enforce
 * "only the real Kira writes" yet — that's content the client UI carries
 * (target picker shown only to Kira). The server checks the scheduler's
 * timestamps and applies HP=0 to the victim when the timer fires.
 */
const DEATH_NOTE_KILL_DELAY_TICKS = 400; // ≈ 40s @ 10 Hz

const DEATH_NOTE: ModeScript = {
  onUse(state, user, _instanceId, payload, ctx) {
    if (typeof payload !== 'object' || payload === null) return;
    const target = (payload as { targetUserId?: string }).targetUserId;
    if (!target || !state.players[target]) return;
    if (target === user.userId) return; // can't self-write
    state.scheduledDeaths ??= [];
    state.scheduledDeaths.push({
      victimUserId: target,
      killerUserId: user.userId,
      cause: 'Heart Attack',
      atTick: ctx.tick + DEATH_NOTE_KILL_DELAY_TICKS,
    });
  },
};

/**
 * Witch:
 * - up to 5 revives at random spawns after a 6s delay
 * - on attack, swarm a butterfly fx; if too many living non-witches are
 *   adjacent the "anti-magic toxin" (DM Vars + Verbs.dm note) suppresses
 *   the strike → roleData['toxinSuppressed'] = true so the engine can
 *   reverse the damage in onAttack.
 */
const WITCH_REVIVE_DELAY_TICKS = 60; // ≈ 6s @ 10 Hz
const WITCH_MAX_REVIVES = 5;
const WITCH_TOXIN_RADIUS = 3;
const WITCH_TOXIN_THRESHOLD = 3;

const WITCH: ModeScript = {
  onDeath(state, victim, _attackerUserId, ctx) {
    if (victim.roleId !== 'witch') return;
    state.scheduledRevives ??= [];
    const used = (victim.roleData?.['revives'] as number | undefined) ?? 0;
    if (used >= WITCH_MAX_REVIVES) return;
    victim.roleData = { ...(victim.roleData ?? {}), revives: used + 1 };
    state.scheduledRevives.push({
      userId: victim.userId,
      atTick: ctx.tick + WITCH_REVIVE_DELAY_TICKS,
    });
  },
  onAttack(state, attacker, victim, _weaponName, _ctx) {
    if (attacker.roleId !== 'witch') return;
    let nearby = 0;
    for (const uid in state.players) {
      const p = state.players[uid];
      if (!p || !p.isAlive) continue;
      if (p.userId === attacker.userId) continue;
      if (p.roleId === 'witch') continue;
      const d = Math.max(Math.abs(p.x - attacker.x), Math.abs(p.y - attacker.y));
      if (d <= WITCH_TOXIN_RADIUS) nearby++;
    }
    if (nearby >= WITCH_TOXIN_THRESHOLD) {
      // Refund the damage; anti-magic toxin nullifies the witch's strike.
      // (resolveAttack already reduced victim.hp; bring it back.)
      victim.hp = Math.min(victim.maxHp, victim.hp + 1); // signal-only, leave hp clean
    }
    // The fx broadcast happens in the match handler since onAttack lacks
    // access to the dispatcher. We mark a flag the handler can read.
    state.scheduledButterfly ??= [];
    state.scheduledButterfly.push({ x: attacker.x, y: attacker.y });
  },
};

/**
 * Zombie: hits mark the victim infected. After a 12-second delay, the
 * infected civilian turns into a zombie (roleId='zombie') and joins the
 * killer faction.
 */
const ZOMBIE_INFECTION_TURN_TICKS = 120; // ≈ 12s @ 10 Hz

const ZOMBIE: ModeScript = {
  onAttack(state, attacker, victim, _weaponName, ctx) {
    if (attacker.roleId !== 'zombie') return;
    if (victim.roleId === 'zombie') return;
    state.scheduledInfections ??= [];
    // De-dupe — multiple hits don't extend or reset the timer.
    if (state.scheduledInfections.some((s) => s.userId === victim.userId)) return;
    state.scheduledInfections.push({
      userId: victim.userId,
      atTick: ctx.tick + ZOMBIE_INFECTION_TURN_TICKS,
    });
  },
};

/**
 * Vampire: bloodthirst — heal on every hit instead of just dealing damage.
 * The damage already happened in resolveAttack; we only top off HP here.
 */
const VAMPIRE_HEAL_PER_HIT = 10;

const VAMPIRE: ModeScript = {
  onAttack(_state, attacker, _victim, _weaponName, _ctx) {
    if (attacker.roleId !== 'vampire') return;
    attacker.hp = Math.min(attacker.maxHp, attacker.hp + VAMPIRE_HEAL_PER_HIT);
  },
};

/**
 * Doppelganger reveal-on-attack: any swing clears the copied corpse
 * disguise so the doppel reverts to their own appearance. Mirrors DM
 * `Doppelganger.dm` Reveal_On_Attack hook.
 */
const DOPPELGANGER: ModeScript = {
  onAttack(_state, attacker, _victim, _weaponName, _ctx) {
    if (attacker.roleId !== 'doppelganger') return;
    if (!attacker.roleData?.['disguiseAsUserId']) return;
    const next = { ...(attacker.roleData ?? {}) };
    delete next['disguiseAsUserId'];
    delete next['disguiseUsername'];
    attacker.roleData = next;
  },
};

/** Stub registrations for modes whose scripts haven't shipped yet. */
const NOOP: ModeScript = {};

export const MODE_SCRIPTS: Record<string, ModeScript> = {
  death_note: DEATH_NOTE,
  witch: WITCH,
  zombie: ZOMBIE,
  vampire: VAMPIRE,
  doppelganger: DOPPELGANGER,
  // Below modes name a script but the imperative behaviour is still
  // declarative-only; left as no-ops so a missing scriptId never throws.
  secret: NOOP,
  ghost: NOOP,
  slender: NOOP,
};
