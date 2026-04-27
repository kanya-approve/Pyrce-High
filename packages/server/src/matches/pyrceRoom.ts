import {
  type C2SLobbyStartGame,
  type C2SMoveIntent,
  DIRECTION_DELTAS,
  type Facing,
  MatchPhase,
  OpCode,
  type S2CInitialSnapshot,
  type S2CPhaseChange,
  type S2CPlayerMoved,
  WIRE_PROTOCOL_VERSION,
} from '@pyrce/shared';
import { tilemap } from '../world/tilemap.js';
import {
  buildLabel,
  countPresences,
  EMPTY_GRACE_TICKS,
  MAX_PLAYERS,
  MOVE_COOLDOWN_TICKS,
  type PlayerInGame,
  type PyrceMatchState,
  TICK_RATE,
  toPublicPlayerInGame,
} from './state.js';

export const MATCH_NAME = 'pyrce_room';

interface MatchInitParams {
  hostUserId?: string;
  matchName?: string;
  gameModeId?: string;
}

/**
 * Match handler functions are registered with `initializer.registerMatch(name,
 * { matchInit, ... })`. Goja resolves the property values by name; passing
 * named function declarations (rather than arrows assigned to consts) keeps
 * the runtime happy across Goja versions and is consistent with the RPC
 * handler convention in this package.
 */
export function matchInit(
  _ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  params: { [k: string]: string | number | boolean | null },
): { state: PyrceMatchState; tickRate: number; label: string } {
  const p = params as unknown as MatchInitParams;
  const state: PyrceMatchState = {
    schemaVersion: 1,
    matchName: p?.matchName ?? 'Pyrce High',
    hostUserId: p?.hostUserId ?? null,
    gameModeId: p?.gameModeId ?? null,
    phase: MatchPhase.Lobby,
    presences: {},
    players: {},
    tickN: 0,
    tickN_lastNonEmpty: 0,
  };
  return {
    state,
    tickRate: TICK_RATE,
    label: JSON.stringify(buildLabel(state, WIRE_PROTOCOL_VERSION)),
  };
}

export function matchJoinAttempt(
  _ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  _dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: PyrceMatchState,
  presence: nkruntime.Presence,
  _metadata: { [k: string]: unknown },
): { state: PyrceMatchState; accept: boolean; rejectMessage?: string } {
  if (countPresences(state) >= MAX_PLAYERS) {
    return { state, accept: false, rejectMessage: 'match_full' };
  }
  // Reconnection always allowed if the user already has a slot.
  if (state.presences[presence.userId] || state.players[presence.userId]) {
    return { state, accept: true };
  }
  // Pre-game: always accept; in-game joining is rejected until the lobby
  // re-opens (the phase machine will gate this once M5 lands).
  if (state.phase !== MatchPhase.Lobby) {
    return { state, accept: false, rejectMessage: 'match_in_progress' };
  }
  return { state, accept: true };
}

export function matchJoin(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: PyrceMatchState,
  presences: nkruntime.Presence[],
): { state: PyrceMatchState } {
  for (const p of presences) {
    state.presences[p.userId] = p;
    logger.info('match join: user=%s session=%s phase=%s', p.userId, p.sessionId, state.phase);

    // If the match is already in InGame and this user has a player slot
    // (i.e. they're reconnecting), send a catch-up snapshot. The shape is
    // the same as S2C_PHASE_CHANGE-to-InGame; we use a dedicated opcode so
    // clients can distinguish a fresh round start from a rejoin.
    if (state.phase === MatchPhase.InGame) {
      sendInitialSnapshot(dispatcher, state, p);
    }
  }
  state.tickN_lastNonEmpty = tick;
  refreshLabel(dispatcher, state);
  return { state };
}

export function matchLeave(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: PyrceMatchState,
  presences: nkruntime.Presence[],
): { state: PyrceMatchState } {
  for (const p of presences) {
    delete state.presences[p.userId];
    if (state.phase === MatchPhase.Lobby) {
      // Pre-game leave: drop the player slot too. (In-game leave keeps the
      // slot so reconnect works; cleanup is handled by the empty-reaper.)
      delete state.players[p.userId];
    }
    logger.info('match leave (phase=%s): user=%s', state.phase, p.userId);
  }
  refreshLabel(dispatcher, state);
  return { state };
}

export function matchLoop(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: PyrceMatchState,
  messages: nkruntime.MatchMessage[],
): { state: PyrceMatchState } | null {
  state.tickN = tick;
  if (countPresences(state) > 0) {
    state.tickN_lastNonEmpty = tick;
  } else if (tick - state.tickN_lastNonEmpty > EMPTY_GRACE_TICKS) {
    return null; // dispose
  }

  for (const m of messages) {
    handleMessage(state, m, tick, dispatcher, logger);
  }

  return { state };
}

export function matchTerminate(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  _dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: PyrceMatchState,
  graceSeconds: number,
): { state: PyrceMatchState } {
  logger.info('match terminating (grace=%d): %s', graceSeconds, state.matchName);
  return { state };
}

export function matchSignal(
  _ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  _dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: PyrceMatchState,
  data: string,
): { state: PyrceMatchState; data: string } {
  // Admin / cross-pod operations land here in M5+.
  return { state, data };
}

// ---------- internals ----------

function handleMessage(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  tick: number,
  dispatcher: nkruntime.MatchDispatcher,
  logger: nkruntime.Logger,
): void {
  switch (m.opCode) {
    case OpCode.C2S_LOBBY_START_GAME:
      handleStartGame(state, m, dispatcher, logger);
      break;
    case OpCode.C2S_MOVE_INTENT:
      handleMoveIntent(state, m, tick, dispatcher);
      break;
    default:
      // Unknown opcodes are silently dropped — this stays forwards-compatible
      // with newer clients that send opcodes we don't recognise yet.
      break;
  }
}

function handleStartGame(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
  logger: nkruntime.Logger,
): void {
  if (state.phase !== MatchPhase.Lobby) return;
  if (m.sender.userId !== state.hostUserId) {
    sendError(dispatcher, m.sender, 'not_host', 'only the host can start');
    return;
  }
  let req: C2SLobbyStartGame = {};
  const body = decode(m.data);
  if (body.length > 0) {
    try {
      req = JSON.parse(body) as C2SLobbyStartGame;
    } catch {
      // ignore — fall through with empty req
    }
  }
  // M5 will drive mode selection here. M2 hardcodes 'normal'.
  state.gameModeId = req.gameModeId ?? 'normal';
  state.phase = MatchPhase.InGame;
  assignSpawns(state);
  broadcastPhaseChange(dispatcher, state);
  refreshLabel(dispatcher, state);
  logger.info(
    'phase: Lobby -> InGame, mode=%s, players=%d',
    state.gameModeId,
    Object.keys(state.players).length,
  );
}

function handleMoveIntent(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  tick: number,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  if (tick - player.lastMoveTickN < MOVE_COOLDOWN_TICKS) return;

  let req: C2SMoveIntent;
  try {
    req = JSON.parse(decode(m.data)) as C2SMoveIntent;
  } catch {
    return;
  }
  const delta = DIRECTION_DELTAS[req.dir as Facing];
  if (!delta) return;
  const nx = player.x + delta.dx;
  const ny = player.y + delta.dy;
  // Update facing even if we can't move — feels more responsive.
  player.facing = req.dir as Facing;
  if (!tilemap.isPassable(nx, ny)) {
    // Bumped a wall: still notify so the client can play a bump animation
    // and clear its prediction; only facing changed.
    broadcastPlayerMoved(dispatcher, state, player, tick);
    return;
  }
  // Reject collisions with other players (simple O(n) check; fine at 22).
  for (const otherId in state.players) {
    if (otherId === player.userId) continue;
    const o = state.players[otherId];
    if (o && o.x === nx && o.y === ny) return;
  }

  player.x = nx;
  player.y = ny;
  player.lastMoveTickN = tick;
  broadcastPlayerMoved(dispatcher, state, player, tick);
}

function assignSpawns(state: PyrceMatchState): void {
  const spawns = tilemap.playerSpawns;
  let i = 0;
  for (const userId in state.presences) {
    const presence = state.presences[userId];
    if (!presence) continue;
    const sp = spawns[i % spawns.length];
    if (!sp) continue;
    state.players[userId] = {
      userId,
      username: presence.username,
      x: sp.x,
      y: sp.y,
      facing: 'S',
      lastMoveTickN: 0,
    };
    i++;
  }
}

function broadcastPhaseChange(dispatcher: nkruntime.MatchDispatcher, state: PyrceMatchState): void {
  const players = Object.values(state.players).map(toPublicPlayerInGame);
  const payload: S2CPhaseChange = {
    phase: state.phase,
    gameModeId: state.gameModeId,
    players,
  };
  dispatcher.broadcastMessage(OpCode.S2C_PHASE_CHANGE, JSON.stringify(payload), null, null, true);
}

function broadcastPlayerMoved(
  dispatcher: nkruntime.MatchDispatcher,
  _state: PyrceMatchState,
  player: PlayerInGame,
  tick: number,
): void {
  const payload: S2CPlayerMoved = {
    userId: player.userId,
    x: player.x,
    y: player.y,
    facing: player.facing,
    tickN: tick,
  };
  dispatcher.broadcastMessage(OpCode.S2C_PLAYER_MOVED, JSON.stringify(payload), null, null, true);
}

function sendInitialSnapshot(
  dispatcher: nkruntime.MatchDispatcher,
  state: PyrceMatchState,
  recipient: nkruntime.Presence,
): void {
  const players = Object.values(state.players).map(toPublicPlayerInGame);
  const self = state.players[recipient.userId];
  const payload: S2CInitialSnapshot = {
    phase: state.phase,
    gameModeId: state.gameModeId,
    players,
    ...(self ? { self: toPublicPlayerInGame(self) } : {}),
  };
  dispatcher.broadcastMessage(
    OpCode.S2C_INITIAL_SNAPSHOT,
    JSON.stringify(payload),
    [recipient],
    null,
    true,
  );
}

function sendError(
  dispatcher: nkruntime.MatchDispatcher,
  recipient: nkruntime.Presence,
  code: string,
  message: string,
): void {
  dispatcher.broadcastMessage(
    OpCode.S2C_ERROR,
    JSON.stringify({ code, message }),
    [recipient],
    null,
    true,
  );
}

function refreshLabel(dispatcher: nkruntime.MatchDispatcher, state: PyrceMatchState): void {
  dispatcher.matchLabelUpdate(JSON.stringify(buildLabel(state, WIRE_PROTOCOL_VERSION)));
}

/**
 * Decode the raw match-data payload. Nakama's TS runtime hands us either a
 * UTF-8 string or a Uint8Array depending on how the sender called
 * `sendMatchState`; this normalises to string for JSON.parse.
 */
function decode(data: string | ArrayBuffer): string {
  if (typeof data === 'string') return data;
  return String.fromCharCode.apply(null, Array.from(new Uint8Array(data)));
}
