import type { Facing, MatchLabel, MatchPhase, PublicPlayerInGame } from '@pyrce/shared';

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

  /** Tick counter, monotonically increasing. */
  tickN: number;

  /** Tick at which the match last had >0 presences (used for empty-reaping). */
  tickN_lastNonEmpty: number;
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
