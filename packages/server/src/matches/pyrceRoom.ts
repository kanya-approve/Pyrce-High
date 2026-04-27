import {
  type C2SContainerLook,
  type C2SContainerPut,
  type C2SContainerTake,
  type C2SInvCraft,
  type C2SInvDrop,
  type C2SInvEquip,
  type C2SInvPickup,
  type C2SInvSetHotkey,
  type C2SInvUse,
  type C2SLobbyStartGame,
  type C2SMoveIntent,
  DIRECTION_DELTAS,
  type Facing,
  MatchPhase,
  OpCode,
  type PublicGroundItem,
  type S2CContainerContents,
  type S2CCraftResult,
  type S2CInitialSnapshot,
  type S2CInvDelta,
  type S2CInvFull,
  type S2CPhaseChange,
  type S2CPlayerMoved,
  type S2CWorldGroundItemDelta,
  type S2CWorldGroundItems,
  WIRE_PROTOCOL_VERSION,
} from '@pyrce/shared';
import { addItem, craft, findInstance, removeItem, setEquipped, setHotkey } from '../inventory.js';
import { type ContainerInstance, seedContainers } from '../world/containers.js';
import { fromInstance } from '../world/groundItems.js';
import { tilemap } from '../world/tilemap.js';
import {
  buildLabel,
  countPresences,
  EMPTY_GRACE_TICKS,
  MAX_PLAYERS,
  MOVE_COOLDOWN_TICKS,
  newPlayerInGame,
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
    groundItems: {},
    containers: {},
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
  if (state.presences[presence.userId] || state.players[presence.userId]) {
    return { state, accept: true };
  }
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

    if (state.phase === MatchPhase.InGame) {
      sendInitialSnapshot(dispatcher, state, p);
      sendInvFull(dispatcher, state, p);
      sendGroundItemsFull(dispatcher, state, [p]);
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
    return null;
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
    case OpCode.C2S_INV_PICKUP:
      handleInvPickup(state, m, dispatcher);
      break;
    case OpCode.C2S_INV_DROP:
      handleInvDrop(state, m, dispatcher);
      break;
    case OpCode.C2S_INV_EQUIP:
      handleInvEquip(state, m, dispatcher);
      break;
    case OpCode.C2S_INV_SET_HOTKEY:
      handleInvSetHotkey(state, m, dispatcher);
      break;
    case OpCode.C2S_INV_USE:
      handleInvUse(state, m, dispatcher, logger);
      break;
    case OpCode.C2S_INV_CRAFT:
      handleInvCraft(state, m, dispatcher);
      break;
    case OpCode.C2S_CONTAINER_LOOK:
      handleContainerLook(state, m, dispatcher);
      break;
    case OpCode.C2S_CONTAINER_TAKE:
      handleContainerTake(state, m, dispatcher);
      break;
    case OpCode.C2S_CONTAINER_PUT:
      handleContainerPut(state, m, dispatcher);
      break;
    default:
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
      // ignore
    }
  }
  state.gameModeId = req.gameModeId ?? 'normal';
  state.phase = MatchPhase.InGame;
  assignSpawns(state);
  state.containers = seedContainers();
  state.groundItems = {};
  broadcastPhaseChange(dispatcher, state);
  for (const userId in state.presences) {
    const p = state.presences[userId];
    if (p) {
      sendInvFull(dispatcher, state, p);
    }
  }
  sendGroundItemsFull(dispatcher, state, null);
  refreshLabel(dispatcher, state);
  logger.info(
    'phase: Lobby -> InGame, mode=%s, players=%d, containers=%d',
    state.gameModeId,
    Object.keys(state.players).length,
    Object.keys(state.containers).length,
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
  player.facing = req.dir as Facing;
  if (!tilemap.isPassable(nx, ny)) {
    broadcastPlayerMoved(dispatcher, player, tick);
    return;
  }
  for (const otherId in state.players) {
    if (otherId === player.userId) continue;
    const o = state.players[otherId];
    if (o && o.x === nx && o.y === ny) return;
  }
  player.x = nx;
  player.y = ny;
  player.lastMoveTickN = tick;
  broadcastPlayerMoved(dispatcher, player, tick);
}

// ---------- inventory handlers ----------

function handleInvPickup(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  const req = parseBody<C2SInvPickup>(m.data);
  if (!req) return;
  const ground = state.groundItems[req.groundItemId];
  if (!ground) return;
  if (!withinPickupRange(player, ground.x, ground.y)) {
    sendError(dispatcher, m.sender, 'too_far', 'item not adjacent');
    return;
  }
  const inst = addItem(player.inventory, ground.itemId, ground.count, ground.data);
  if (!inst) return;
  delete state.groundItems[req.groundItemId];
  sendInvDelta(dispatcher, state, m.sender, { upserted: [inst], weight: player.inventory.weight });
  broadcastGroundItemDelta(dispatcher, { removed: [req.groundItemId] });
}

function handleInvDrop(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  const req = parseBody<C2SInvDrop>(m.data);
  if (!req) return;
  const removed = removeItem(player.inventory, req.instanceId);
  if (!removed) return;
  const ground = fromInstance(removed, player.x, player.y);
  state.groundItems[ground.groundItemId] = ground;
  sendInvDelta(dispatcher, state, m.sender, {
    removed: [req.instanceId],
    hotkeys: player.inventory.hotkeys,
    equipped: player.inventory.equipped,
    weight: player.inventory.weight,
  });
  broadcastGroundItemDelta(dispatcher, { upserted: [toPublicGroundItem(ground)] });
}

function handleInvEquip(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  const req = parseBody<C2SInvEquip>(m.data);
  if (!req) return;
  if (!setEquipped(player.inventory, req.instanceId)) {
    sendError(dispatcher, m.sender, 'no_such_instance', 'cannot equip');
    return;
  }
  sendInvDelta(dispatcher, state, m.sender, { equipped: player.inventory.equipped });
}

function handleInvSetHotkey(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  const req = parseBody<C2SInvSetHotkey>(m.data);
  if (!req) return;
  if (req.slot < 1 || req.slot > 5) return;
  if (!setHotkey(player.inventory, req.slot, req.instanceId)) {
    sendError(dispatcher, m.sender, 'no_such_instance', 'cannot bind hotkey');
    return;
  }
  sendInvDelta(dispatcher, state, m.sender, { hotkeys: player.inventory.hotkeys });
}

function handleInvUse(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
  logger: nkruntime.Logger,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  const req = parseBody<C2SInvUse>(m.data);
  if (!req) return;
  const inst = findInstance(player.inventory, req.instanceId);
  if (!inst) return;
  // Real effects land in M4 (combat) and M5 (mode-specific items). For M3 we
  // log usage and acknowledge; this proves the wire path works.
  logger.info('use: user=%s item=%s', player.userId, inst.itemId);
  sendInvDelta(dispatcher, state, m.sender, {});
}

function handleInvCraft(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  const req = parseBody<C2SInvCraft>(m.data);
  if (!req) return;
  const result = craft(player.inventory, req.recipeId);
  const payload: S2CCraftResult =
    result.ok && result.output
      ? { ok: true, recipeId: req.recipeId, instanceId: result.output.instanceId }
      : { ok: false, recipeId: req.recipeId, error: result.error ?? 'craft_failed' };
  dispatcher.broadcastMessage(
    OpCode.S2C_CRAFT_RESULT,
    JSON.stringify(payload),
    [m.sender],
    null,
    true,
  );
  if (result.ok) {
    sendInvFull(dispatcher, state, m.sender);
  }
}

// ---------- container handlers ----------

function handleContainerLook(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  const req = parseBody<C2SContainerLook>(m.data);
  if (!req) return;
  // Resolve container by coord. Multiple containers can share a tile in
  // theory; we return the first match. Proximity (Chebyshev 1) enforced
  // against the player, not against the requested tile (matches DM `oview(1)`).
  let target: ContainerInstance | null = null;
  for (const id in state.containers) {
    const c = state.containers[id];
    if (!c) continue;
    if (c.x === req.x && c.y === req.y) {
      target = c;
      break;
    }
  }
  if (!target) return;
  if (!withinContainerRange(player, target)) {
    sendError(dispatcher, m.sender, 'too_far', 'container not adjacent');
    return;
  }
  sendContainerContents(dispatcher, m.sender, target);
}

function handleContainerTake(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  const req = parseBody<C2SContainerTake>(m.data);
  if (!req) return;
  const c = state.containers[req.containerId];
  if (!c) return;
  if (!withinContainerRange(player, c)) return;
  const idx = c.contents.findIndex((it) => it.instanceId === req.instanceId);
  if (idx === -1) return;
  const taken = c.contents[idx];
  if (!taken) return;
  c.contents.splice(idx, 1);
  const inst = addItem(player.inventory, taken.itemId, taken.count, taken.data);
  if (!inst) {
    // shouldn't happen — restore and bail
    c.contents.push(taken);
    return;
  }
  sendInvDelta(dispatcher, state, m.sender, { upserted: [inst], weight: player.inventory.weight });
  sendContainerContents(dispatcher, m.sender, c);
}

function handleContainerPut(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  const req = parseBody<C2SContainerPut>(m.data);
  if (!req) return;
  const c = state.containers[req.containerId];
  if (!c) return;
  if (!withinContainerRange(player, c)) return;
  const removed = removeItem(player.inventory, req.instanceId);
  if (!removed) return;
  c.contents.push(removed);
  sendInvDelta(dispatcher, state, m.sender, {
    removed: [req.instanceId],
    hotkeys: player.inventory.hotkeys,
    equipped: player.inventory.equipped,
    weight: player.inventory.weight,
  });
  sendContainerContents(dispatcher, m.sender, c);
}

// ---------- world setup ----------

function assignSpawns(state: PyrceMatchState): void {
  const spawns = tilemap.playerSpawns;
  let i = 0;
  for (const userId in state.presences) {
    const presence = state.presences[userId];
    if (!presence) continue;
    const sp = spawns[i % spawns.length];
    if (!sp) continue;
    state.players[userId] = newPlayerInGame(userId, presence.username, sp.x, sp.y);
    i++;
  }
}

// ---------- broadcasts ----------

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

function sendInvFull(
  dispatcher: nkruntime.MatchDispatcher,
  state: PyrceMatchState,
  recipient: nkruntime.Presence,
): void {
  const player = state.players[recipient.userId];
  if (!player) return;
  const payload: S2CInvFull = { inventory: player.inventory };
  dispatcher.broadcastMessage(
    OpCode.S2C_INV_FULL,
    JSON.stringify(payload),
    [recipient],
    null,
    true,
  );
}

function sendInvDelta(
  dispatcher: nkruntime.MatchDispatcher,
  _state: PyrceMatchState,
  recipient: nkruntime.Presence,
  delta: S2CInvDelta,
): void {
  dispatcher.broadcastMessage(OpCode.S2C_INV_DELTA, JSON.stringify(delta), [recipient], null, true);
}

function sendGroundItemsFull(
  dispatcher: nkruntime.MatchDispatcher,
  state: PyrceMatchState,
  targets: nkruntime.Presence[] | null,
): void {
  const items: PublicGroundItem[] = Object.values(state.groundItems).map(toPublicGroundItem);
  const payload: S2CWorldGroundItems = { items };
  dispatcher.broadcastMessage(
    OpCode.S2C_WORLD_GROUND_ITEMS,
    JSON.stringify(payload),
    targets,
    null,
    true,
  );
}

function broadcastGroundItemDelta(
  dispatcher: nkruntime.MatchDispatcher,
  delta: S2CWorldGroundItemDelta,
): void {
  dispatcher.broadcastMessage(
    OpCode.S2C_WORLD_GROUND_ITEM_DELTA,
    JSON.stringify(delta),
    null,
    null,
    true,
  );
}

function sendContainerContents(
  dispatcher: nkruntime.MatchDispatcher,
  recipient: nkruntime.Presence,
  c: ContainerInstance,
): void {
  const payload: S2CContainerContents = {
    container: {
      containerId: c.containerId,
      kind: c.kind,
      x: c.x,
      y: c.y,
      contents: c.contents,
    },
  };
  dispatcher.broadcastMessage(
    OpCode.S2C_CONTAINER_CONTENTS,
    JSON.stringify(payload),
    [recipient],
    null,
    true,
  );
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

// ---------- helpers ----------

function withinPickupRange(player: PlayerInGame, x: number, y: number): boolean {
  // DM picks up only on-tile; we mirror that. Adjacent pickup is M3.x polish.
  return player.x === x && player.y === y;
}

function withinContainerRange(player: PlayerInGame, c: { x: number; y: number }): boolean {
  return Math.max(Math.abs(player.x - c.x), Math.abs(player.y - c.y)) <= 1;
}

function toPublicGroundItem(g: import('../world/groundItems.js').GroundItem): PublicGroundItem {
  return { groundItemId: g.groundItemId, itemId: g.itemId, count: g.count, x: g.x, y: g.y };
}

function decode(data: string | ArrayBuffer): string {
  if (typeof data === 'string') return data;
  return String.fromCharCode.apply(null, Array.from(new Uint8Array(data)));
}

function parseBody<T>(data: string | ArrayBuffer): T | null {
  const body = decode(data);
  if (body.length === 0) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}
