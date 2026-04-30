import {
  type Facing,
  INITIAL_INVENTORY,
  type InventoryState,
  type MatchLabel,
  type MatchPhase,
  type PublicPlayerInGame,
  type RoleId,
} from '@pyrce/shared';
import type { InGameClock } from '../mode.js';
import type { ContainerInstance } from '../world/containers.js';
import type { GroundItem } from '../world/groundItems.js';

/**
 * In-memory match state owned by Nakama. Lives on the pod hosting the match;
 * mutated by every handler. Schema-versioned so future evolutions can detect
 * the shape on rolling restarts.
 *
 * NOTE: This type intentionally references `nkruntime.Presence`, which means
 * it MUST stay server-side. The shared package only exports DTOs that are
 * safe for the browser to import.
 */
/** Lethal weapons that apply a bleed-over-time. */
export const BLEEDING_WEAPONS: readonly string[] = ['knife', 'billhook', 'axe', 'spear'];

export interface PlayerInGame {
  userId: string;
  username: string;
  x: number;
  y: number;
  facing: Facing;
  /** Server tick of the last accepted move. Movement throttled by cooldown. */
  lastMoveTickN: number;
  /** Server tick of the last accepted attack. */
  lastAttackTickN: number;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  isAlive: boolean;
  /** Watcher (spectator) mode after death. */
  isWatching: boolean;
  /** True once the player has escaped via the Steel Door. They're effectively a non-killer survivor. */
  hasEscaped?: boolean;
  /** Classroom assigned at game start ('A1', 'A2', 'B1', ...). Null until the player is placed. */
  classroom?: string;
  /** Number of kills landed; 0..8. Drives the bloody-overlay tier on the public sprite. */
  bloody?: number;
  /** Death Note: this player accepted the Shinigami Eyes deal — sees real names. */
  shinigamiEyes?: boolean;
  /** True name for body-discovery messaging — leak-safe; only revealed on death. */
  realName: string;
  inventory: InventoryState;
  /** Assigned by the mode engine on Lobby→InGame. Default 'civilian'. */
  roleId: RoleId;
  /** Per-role free-form storage: witch revives used, kira pending writes, … */
  roleData?: Record<string, unknown>;
  /**
   * Tick when this player's presence dropped (matchLeave during InGame).
   * Cleared when they rejoin. Drained in matchLoop — players still gone
   * after RECONNECT_GRACE_TICKS get killed off so the round can resolve.
   */
  disconnectedAtTick?: number;
}

/**
 * Persistent corpse left after a player dies. Lives in MatchState.corpses
 * until the round ends. Searchable by anyone Chebyshev≤1; first non-killer
 * search triggers the body-discovered announcement.
 */
export interface Corpse {
  corpseId: string;
  victimUserId: string;
  victimUsername: string;
  victimRealName: string;
  killerUserId: string | null;
  cause: string;
  x: number;
  y: number;
  contents: import('@pyrce/shared').ItemInstance[];
  discovered: boolean;
  discoveredByUserId: string | null;
  /** Vampire mode: true once the body's blood has been drained. */
  drained?: boolean;
}

export interface PyrceMatchState {
  schemaVersion: 1;

  /** Display name shown in the lobby browser. */
  matchName: string;

  /** User id of whoever issued the createMatch RPC. */
  hostUserId: string | null;

  /** Currently selected game mode (null until lobby vote resolves). */
  gameModeId: string | null;

  phase: MatchPhase;

  /** userId -> presence; populated in matchJoin, removed in matchLeave. */
  presences: { [userId: string]: nkruntime.Presence };

  /** userId -> in-game state. Populated when phase enters InGame. */
  players: { [userId: string]: PlayerInGame };

  /** groundItemId -> ground item state. Populated on InGame entry. */
  groundItems: { [groundItemId: string]: GroundItem };

  /** containerId -> container state. Seeded once on InGame entry. */
  containers: { [containerId: string]: ContainerInstance };

  /** corpseId -> corpse. Persists for the round. */
  corpses: { [corpseId: string]: Corpse };

  /** In-game clock; null until phase enters InGame. */
  clock: InGameClock | null;

  /** True once the win check has resolved; prevents double-broadcast. */
  ended: boolean;

  /** Tick counter, monotonically increasing. */
  tickN: number;

  /** Tick at which the match last had >0 presences (used for empty-reaping). */
  tickN_lastNonEmpty: number;

  /** Doors briefly auto-open when stepped on. Drained in matchLoop. */
  pendingDoorCloses?: Array<{ x: number; y: number; closeAtTick: number }>;

  /** Persistent door open/closed state, keyed by `${x},${y}`. */
  openDoors?: { [coordKey: string]: boolean };

  /** Lobby mode votes: userId → modeId. Cleared on InGame transition. */
  modeVotes?: { [userId: string]: string };

  /** In-round end-game votes: set of userIds who've voted yes. */
  endGameVotes?: { [userId: string]: true };

  /**
   * Vote-kick: `kickVotes[targetUserId][voterUserId] = true`. When >50% of
   * alive players vote against a target, the server kills them off.
   */
  kickVotes?: { [targetUserId: string]: { [voterUserId: string]: true } };

  // ---------- mode-script scheduled effects ----------

  /** Death Note: heart-attack timers. */
  scheduledDeaths?: Array<{
    victimUserId: string;
    killerUserId: string | null;
    cause: string;
    atTick: number;
    /** Tick at which the victim should be warned ahead of the kill. */
    warnAtTick?: number;
    warned?: boolean;
  }>;

  /** Witch: pending revive timers. */
  scheduledRevives?: Array<{ userId: string; atTick: number }>;

  /** Zombie: pending infection-turn timers. */
  scheduledInfections?: Array<{ userId: string; atTick: number }>;

  /** Witch: pending butterfly fx broadcasts queued by the script. */
  scheduledButterfly?: Array<{ x: number; y: number }>;

  /**
   * In-flight corpse-search consent prompts: requestId → details.
   * Cleared on accept/decline or 15s timeout.
   */
  searchRequests?: {
    [requestId: string]: {
      searcherUserId: string;
      corpseId: string;
      askedAtTick: number;
    };
  };

  /** Per-userId corpse-pull state: which corpse is each player dragging. */
  pullingCorpse?: { [userId: string]: string };

  /** Per-userId KO timers: tick when the KO ends. */
  koUntilTick?: { [userId: string]: number };

  /** Per-userId bleed timers: tick when the bleed effect ends. */
  bleedUntilTick?: { [userId: string]: number };

  /** Per-userId frozen timers: tick when the frozen state ends (feather). */
  frozenUntilTick?: { [userId: string]: number };

  /** Per-userId sedative-slow timers: tick when the slow effect ends. */
  slowedUntilTick?: { [userId: string]: number };

  /** Per-userId wash cooldown: tick when wash completes (locks player briefly). */
  washingUntilTick?: { [userId: string]: number };

  /** Per-userId sprint state: true while sprint is toggled on. */
  sprinting?: { [userId: string]: true };

  /** Per-userId tick of last sprint stamina drain. */
  lastSprintDrainTick?: { [userId: string]: number };

  /** Per-userId tick of last shove (cooldown). */
  lastShoveTick?: { [userId: string]: number };

  /** Doors locked by mode setup; key is `${x},${y}`. */
  lockedDoors?: { [coordKey: string]: true };

  /** Random 3-digit door code used by door_code_view items. */
  doorCode?: string;

  /**
   * Secret mode: the actual mode whose rules are running underneath. Players
   * see `gameModeId='secret'` and have to figure it out from gameplay. Only
   * revealed in the end-game results.
   */
  secretActualModeId?: string;

  /** Set of light-switch tags currently switched OFF. Drives darkness areas. */
  lightsOff?: { [tag: string]: true };

  /** True once a killer has used Delete_Tapes on a Monitor. */
  tapesDeleted?: boolean;

  /** Pending eye-deal offers: targetUserId → shinigami offerer userId. */
  eyeOffers?: { [targetUserId: string]: { fromUserId: string; expiresAtTick: number } };

  /** Schedule of eye-deal deaths: { victimUserId, atGameMinute }. */
  scheduledEyeDeaths?: Array<{ userId: string; atGameMinute: number }>;
}

/** Build a fresh PlayerInGame, including a deep copy of the empty inventory. */
export function newPlayerInGame(
  userId: string,
  username: string,
  x: number,
  y: number,
): PlayerInGame {
  return {
    userId,
    username,
    x,
    y,
    facing: 'S',
    lastMoveTickN: 0,
    lastAttackTickN: 0,
    hp: 100,
    maxHp: 100,
    stamina: 100,
    maxStamina: 100,
    isAlive: true,
    isWatching: false,
    realName: username, // M5.x may override with role-assigned realname
    inventory: {
      items: [],
      hotkeys: [null, null, null, null, null],
      equipped: null,
      weight: 0,
      weightCap: INITIAL_INVENTORY.weightCap,
    },
    roleId: 'civilian',
    roleData: {},
  };
}

export const TICK_RATE = 10; // Hz
export const MAX_PLAYERS = 22;
export const EMPTY_GRACE_TICKS = TICK_RATE * 30; // dispose after 30s of emptiness
/** A mid-round disconnect kills the player after this many ticks. */
export const RECONNECT_GRACE_TICKS = TICK_RATE * 60;

/**
 * Move cooldown in ticks. At 10Hz, 1 tick = 100ms. We allow 1 tile-step
 * per ~150ms which gives a smooth-but-deliberate walking pace and stops
 * key-mash spam. Set deliberately above the 100ms tick floor so it's
 * always at least 2 ticks between moves.
 */
export const MOVE_COOLDOWN_TICKS = 2;

export function buildLabel(state: PyrceMatchState, protocol: string): MatchLabel {
  return {
    phase: state.phase,
    gameModeId: state.gameModeId,
    count: countPresences(state),
    hostUserId: state.hostUserId,
    name: state.matchName,
    protocol,
  };
}

export function countPresences(state: PyrceMatchState): number {
  let n = 0;
  for (const _ in state.presences) n++;
  return n;
}

export function toPublicPlayerInGame(p: PlayerInGame): PublicPlayerInGame {
  const equippedInst = p.inventory.equipped
    ? p.inventory.items.find((i) => i.instanceId === p.inventory.equipped)
    : null;
  const disguiseAs = p.roleData?.['disguiseAsUserId'] as string | undefined;
  const disguiseUsername = p.roleData?.['disguiseUsername'] as string | undefined;
  // Doppelganger weapon-hide: while disguised, the equipped item is
  // suppressed in the public view so the disguise isn't trivially blown
  // by a visible knife sprite. Self-targeted broadcasts use a different
  // path (sendInvFull/Delta) so the doppel still sees their own gear.
  const hideEquipped = p.roleId === 'doppelganger' && !!disguiseAs;
  return {
    userId: p.userId,
    username: p.username,
    x: p.x,
    y: p.y,
    facing: p.facing,
    hp: p.hp,
    maxHp: p.maxHp,
    isAlive: p.isAlive,
    equippedItemId: hideEquipped ? null : (equippedInst?.itemId ?? null),
    equippedItemBloody: !hideEquipped && equippedInst?.data?.['bloody'] === true,
    ...(disguiseAs ? { disguiseAsUserId: disguiseAs } : {}),
    ...(disguiseUsername ? { disguiseUsername } : {}),
    // Doppelganger-disguised hides the bloody tier too — otherwise a kill
    // count is a giveaway. Standard players publish their bloody level so
    // onlookers see the visual overlay tier.
    bloody: hideEquipped ? 0 : (p.bloody ?? 0),
  };
}
