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
  hp: number;
  maxHp: number;
  isAlive: boolean;
  /** Item id of what's in the player's hand, or null. Cosmetic — drives the
   *  in-hand sprite overlay; full inventory is self-only. */
  equippedItemId: string | null;
  /** True when the equipped item has been bloodied by a kill (visual swap). */
  equippedItemBloody: boolean;
  /**
   * If the player is currently disguised (Doppelganger), this is the userId
   * of the corpse they copied — clients render their hair + nameplate using
   * the disguise.
   */
  disguiseAsUserId?: string;
  /** Username override shown when disguised (matches the copied corpse). */
  disguiseUsername?: string;
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
  equippedItemId: string | null;
  equippedItemBloody: boolean;
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

export interface S2CFxSmoke {
  /** Tile coords of the smoke origin. */
  x: number;
  y: number;
  durationMs: number;
}

export interface S2CDoorState {
  /** Door coordinates from the tilemap doors[] entries. */
  x: number;
  y: number;
  open: boolean;
}

export interface C2SDoorToggle {
  x: number;
  y: number;
}

export interface S2CFxSound {
  /** Audio key — matches the file at /audio/<key>.<ext> on the client. */
  key: string;
  /** World-tile coords; client attenuates volume by Chebyshev distance. */
  x: number;
  y: number;
  /** 0..1 base volume. */
  volume: number;
}

// ----- voting -----

export interface C2SVoteMode {
  /** Mode id; pass empty string or null to withdraw the vote. */
  modeId: string | null;
}

export interface C2SVoteEndGame {
  /** true to vote yes, false to withdraw. */
  vote: boolean;
}

export interface S2CVoteModeTally {
  /** modeId → vote count. */
  tally: { [modeId: string]: number };
  /** Total players who have voted at least once. */
  voted: number;
  /** Total presences in the match. */
  total: number;
}

export interface S2CVoteEndGameTally {
  yes: number;
  /** Number of alive players (the denominator for the >50% threshold). */
  alive: number;
  /** True when the threshold has been met and the round is being ended. */
  resolved: boolean;
}

// ----- body interactions -----

export interface C2SViewProfile {
  userId: string;
}

export interface C2SDragCorpse {
  corpseId: string;
}

export interface S2CProfileView {
  userId: string;
  username: string;
  hp: number;
  maxHp: number;
  isAlive: boolean;
  /** Human readable condition: "Perfect" / "Hurt" / "Dying…" / "Dead". */
  condition: string;
}

export interface S2CFxButterfly {
  /** Tile coords of the butterfly origin (witch's tile). */
  x: number;
  y: number;
  durationMs: number;
}

export interface C2SDoppelgangerCopy {
  /** Adjacent corpse to copy. */
  corpseId: string;
}

export interface C2SVoteKick {
  /** Target userId; pass empty string to withdraw your kick votes. */
  targetUserId: string;
}

export interface S2CVoteKickTally {
  /** Target userId being voted on (null if no active kick vote). */
  targetUserId: string;
  /** Username of the target for client display. */
  targetUsername: string;
  yes: number;
  alive: number;
  resolved: boolean;
}

export interface C2SVendingBuy {
  /** Vending machine tile to buy from. */
  x: number;
  y: number;
}

export interface C2SVampireDrain {
  /** Adjacent corpse to drain blood from. */
  corpseId: string;
}

export interface C2SSearchConsent {
  /** Search request id from S2CSearchRequest. */
  requestId: string;
  accept: boolean;
}

export interface S2CSearchRequest {
  /** Unique id; the responder echoes it in C2SSearchConsent. */
  requestId: string;
  searcherUserId: string;
  searcherUsername: string;
  corpseId: string;
}

export interface S2CSearchDenied {
  corpseId: string;
  reason: string;
}

/**
 * Self-only role-state telemetry: counts only the role itself needs to know
 * (witch revives remaining, vampire bodies drained, etc.). Exposed so the
 * HUD can render a counter without the public PlayerInGame leaking it.
 */
export interface S2CSelfRoleState {
  /** Witch: revives left (5 max). */
  witchRevivesLeft?: number;
  /** Vampire: corpses drained this round. */
  vampireDrained?: number;
}

export interface S2CStudentRoster {
  entries: Array<{
    userId: string;
    username: string;
    isAlive: boolean;
    condition: string;
  }>;
}

export interface S2CFxFeather {
  /** Tile path the feather travels along — start...impact. */
  path: Array<{ x: number; y: number }>;
}

// ----- role abilities -----

export interface C2SRoleAbility {
  /** Ability id understood by the active mode script. */
  ability: 'invisablewalk' | 'quickdash';
}

export interface C2SPullToggle {
  /** Set null to drop. Otherwise pick up an adjacent corpse. */
  corpseId: string | null;
}

// ----- paper / pda / door-code -----

export interface C2SPaperWrite {
  instanceId: import('../ids.js').ItemInstanceId;
  text: string;
}
export interface C2SPaperAirplane {
  instanceId: import('../ids.js').ItemInstanceId;
  targetUserId: string;
}

export interface S2CPaperText {
  instanceId: import('../ids.js').ItemInstanceId;
  text: string;
}
export interface S2CPaperReceived {
  fromUsername: string;
  text: string;
}
export interface S2CDoorCode {
  /** Random 3-digit code generated for this match. */
  code: string;
}

// ----- whisperer ghost-sense -----

export interface S2CGhostSense {
  /** Direction the ghost is from this whisperer (8-way), or null when not in range. */
  direction: 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW' | null;
  /** Approximate distance in tiles, rounded up to 5/15/30. */
  distance: number | null;
}
