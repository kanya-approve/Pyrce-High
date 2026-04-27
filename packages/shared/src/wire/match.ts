/**
 * Wire payload types for match-data opcodes (sent over the realtime socket
 * via `sendMatchState`). These are sister types to the RPC payloads in
 * `wire/rpc.ts` — RPCs are request/response, opcodes are fire-and-forget
 * deltas.
 */
import type { Facing } from '../content/tilemap.js';
import type { MatchPhase } from '../enums.js';

// ---------- Client → Server ----------

export interface C2SMoveIntent {
  dir: Facing;
}

export interface C2SLobbyStartGame {
  /** Mode id chosen for the round. v1 is hardcoded to 'normal'. */
  gameModeId?: string;
}

// ---------- Server → Client ----------

export interface PublicPlayerInGame {
  userId: string;
  username: string;
  x: number;
  y: number;
  facing: Facing;
}

export interface S2CPhaseChange {
  phase: MatchPhase;
  /** Populated when entering `InGame`: the full assigned roster. */
  players?: PublicPlayerInGame[];
  /** Active mode id, if any. */
  gameModeId?: string | null;
}

export interface S2CPlayerMoved {
  userId: string;
  x: number;
  y: number;
  facing: Facing;
  /** Server tick at which the move was committed (for client interpolation). */
  tickN: number;
}

export interface S2CError {
  code: string;
  message?: string;
}

/**
 * Catch-up snapshot sent on (re)join when the match is already in progress.
 * Mirrors `S2CPhaseChange` for the InGame case but is targeted at one user.
 */
export interface S2CInitialSnapshot {
  phase: MatchPhase;
  gameModeId: string | null;
  players: PublicPlayerInGame[];
  /** The recipient's own player record (so the client knows where they spawned). */
  self?: PublicPlayerInGame;
}
