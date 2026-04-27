import type { MatchPhase } from '../enums.js';

/**
 * Public, JSON-serializable label attached to every match. Returned by
 * `listMatches` RPC and updated via `dispatcher.matchLabelUpdate(...)`
 * on every state change that should be visible to the lobby browser.
 */
export interface MatchLabel {
  phase: MatchPhase;
  gameModeId: string | null;
  count: number;
  hostUserId: string | null;
  name: string;
  /** Wire protocol version the match was created against. */
  protocol: string;
}

/**
 * Public view of a player as seen by other clients (no role, no inventory).
 * Self-only fields live in `SelfPlayerSnapshot`.
 */
export interface PublicPlayerSnapshot {
  userId: string;
  username: string;
  characterName: string;
  hairId: string;
  hairColor: string;
  gender: 'male' | 'female';
  isAlive: boolean;
  isWatching: boolean;
  disconnected: boolean;
  hp: number;
  maxHp: number;
}
