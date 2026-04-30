import type { MatchLabel } from '../state/match.js';
import type { ProfileV1 } from '../state/profile.js';

/**
 * RPC IDs registered in the Nakama runtime. Keep in sync with
 * `packages/server/src/main.ts` registerRpc calls.
 */
export const RpcId = {
  LoadProfile: 'loadProfile',
  SaveProfile: 'saveProfile',
  CreateMatch: 'createMatch',
  ListMatches: 'listMatches',
  AllocateGameServer: 'allocateGameServer',
} as const;
export type RpcId = (typeof RpcId)[keyof typeof RpcId];

// loadProfile — empty request, returns the caller's profile (creates default if missing).
export type LoadProfileRequest = Record<string, never>;
export interface LoadProfileResponse {
  profile: ProfileV1;
  created: boolean;
}

// saveProfile — overwrite the caller's profile with the supplied JSON.
export interface SaveProfileRequest {
  profile: ProfileV1;
}
export interface SaveProfileResponse {
  ok: true;
  saved: ProfileV1;
}

// createMatch — host creates a new lobby. Returns the match id + initial label.
export interface CreateMatchRequest {
  name?: string;
  gameModeId?: string;
}
export interface CreateMatchResponse {
  matchId: string;
  label: MatchLabel;
}

// listMatches — browser polls this to populate the room list.
export interface ListMatchesRequest {
  /** Max results to return (server caps at 50). */
  limit?: number;
}
export interface MatchListing {
  matchId: string;
  label: MatchLabel;
  size: number;
}
export interface ListMatchesResponse {
  matches: MatchListing[];
}

// allocateGameServer — Nakama proxies a Kubernetes
// `GameServerAllocation` request to the in-cluster Agones Allocator
// service. On success the client receives the address:port of a freshly
// Allocated GameServer to connect a WebSocket to. The match handler
// keeps the lobby/identity loop; the realtime round runs in the
// returned dedicated process.
export interface AllocateGameServerRequest {
  /** Optional Nakama matchId for telemetry — surfaced as an annotation. */
  matchId?: string;
  /** Optional region label so multi-region clusters can prefer-local. */
  region?: string;
}
export interface AllocateGameServerResponse {
  /** GameServer name (e.g. `pyrce-9p4n2`). */
  gameServerName: string;
  /** Public-routable address (Agones GAME_SERVER_ADDRESS). */
  address: string;
  /** Allocated dynamic port. */
  port: number;
  /** Source-of-truth for the allocation timestamp (ISO-8601). */
  allocatedAt: string;
}

/**
 * RPC envelope returned by Nakama's `client.rpc(...)` — the runtime wraps
 * our JSON in `{ id, payload }`. We keep the shape explicit here for callers.
 */
export interface RpcEnvelope<T> {
  id: string;
  payload: T;
}
