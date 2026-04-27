import {
  type Facing,
  INITIAL_INVENTORY,
  type InventoryState,
  type MatchLabel,
  type MatchPhase,
  type PublicPlayerInGame,
} from '@pyrce/shared';
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
export interface PlayerInGame {
  userId: string;
  username: string;
  x: number;
  y: number;
  facing: Facing;
  /** Server tick of the last accepted move. Movement throttled by cooldown. */
  lastMoveTickN: number;
  inventory: InventoryState;
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

  /** Tick counter, monotonically increasing. */
  tickN: number;

  /** Tick at which the match last had >0 presences (used for empty-reaping). */
  tickN_lastNonEmpty: number;
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
    inventory: {
      items: [],
      hotkeys: [null, null, null, null, null],
      equipped: null,
      weight: 0,
      weightCap: INITIAL_INVENTORY.weightCap,
    },
  };
}

export const TICK_RATE = 10; // Hz
export const MAX_PLAYERS = 22;
export const EMPTY_GRACE_TICKS = TICK_RATE * 30; // dispose after 30s of emptiness

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
  return {
    userId: p.userId,
    username: p.username,
    x: p.x,
    y: p.y,
    facing: p.facing,
  };
}
