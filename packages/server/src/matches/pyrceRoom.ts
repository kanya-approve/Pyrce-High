import type {
  C2SChat,
  C2STypingBegin,
  C2STypingEnd,
  S2CChatMessage,
  S2CTyping,
} from '@pyrce/shared';
import {
  type C2SAttack,
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
  type C2SSearchCorpse,
  type C2STakeFromCorpse,
  DIRECTION_DELTAS,
  type Facing,
  getMode,
  MatchPhase,
  OpCode,
  type PublicCorpse,
  type PublicGroundItem,
  ROLES,
  type RoleId,
  type S2CAnnouncement,
  type S2CClockTick,
  type S2CContainerContents,
  type S2CCorpseContents,
  type S2CCorpseDespawn,
  type S2CCorpseSpawn,
  type S2CCraftResult,
  type S2CDoorState,
  type S2CFxSmoke,
  type S2CGameResult,
  type S2CInitialSnapshot,
  type S2CInvDelta,
  type S2CInvFull,
  type S2CPhaseChange,
  type S2CPlayerDied,
  type S2CPlayerHealth,
  type S2CPlayerHP,
  type S2CPlayerMoved,
  type S2CPlayerStamina,
  type S2CRoleAssigned,
  type S2CWorldGroundItemDelta,
  type S2CWorldGroundItems,
  WIRE_PROTOCOL_VERSION,
} from '@pyrce/shared';
import { routeChat, sanitizeChatBody } from '../chat.js';
import { checkBodyDiscoveries, regenStamina, resolveAttack } from '../combat.js';
import { addItem, craft, findInstance, removeItem, setEquipped, setHotkey } from '../inventory.js';
import {
  applyItemGrants,
  assignRoles,
  buildReveals,
  evaluateWinConditions,
  formatGameClock,
  newClock,
  totalGameMinutes,
} from '../mode.js';
import { type ContainerInstance, seedContainers } from '../world/containers.js';
import { fromInstance } from '../world/groundItems.js';
import { tilemap } from '../world/tilemap.js';
import {
  buildLabel,
  type Corpse,
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

/** Stamina regen runs every Nth tick (cheap, but no need to do it every tick). */
const STAMINA_REGEN_EVERY_TICKS = 5;

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
    corpses: {},
    clock: null,
    ended: false,
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

  if (state.pendingDoorCloses && state.pendingDoorCloses.length > 0) {
    const remaining: typeof state.pendingDoorCloses = [];
    for (const d of state.pendingDoorCloses) {
      if (tick >= d.closeAtTick) {
        const close: S2CDoorState = { x: d.x, y: d.y, open: false };
        dispatcher.broadcastMessage(OpCode.S2C_DOOR_STATE, JSON.stringify(close), null, null, true);
      } else {
        remaining.push(d);
      }
    }
    state.pendingDoorCloses = remaining;
  }

  if (tick % STAMINA_REGEN_EVERY_TICKS === 0) {
    regenStamina(state);
    for (const userId in state.presences) {
      const p = state.players[userId];
      const pres = state.presences[userId];
      if (p && pres) {
        sendStamina(dispatcher, pres, p);
      }
    }
  }

  // Body-discovery scan — players walking past corpses pick them up. Cheap
  // (≤22 × ≤22 per tick = trivial) so no need to rate-limit.
  const discovered = checkBodyDiscoveries(state);
  for (const c of discovered) {
    broadcastAnnouncement(dispatcher, {
      kind: 'body_discovered',
      message: `Warning: dead body located! ${c.victimRealName} found by ${
        state.players[c.discoveredByUserId ?? '']?.username ?? 'someone'
      }.`,
    });
    broadcastCorpseUpdate(dispatcher, c);
  }

  // Game clock + win check: only relevant once we've entered InGame and
  // we haven't already broadcast a result.
  if (state.phase === MatchPhase.InGame && state.clock && !state.ended) {
    const gameMinutes = totalGameMinutes(state.clock, tick, TICK_RATE);
    const formatted = formatGameClock(gameMinutes);
    const intMinute = Math.floor(gameMinutes);
    if (intMinute !== state.clock.lastBroadcastMinute) {
      state.clock.lastBroadcastMinute = intMinute;
      broadcastClock(dispatcher, formatted);
    }
    const modeDef = getMode(state.gameModeId ?? '');
    if (modeDef) {
      const result = evaluateWinConditions(state, modeDef, gameMinutes);
      if (result) {
        state.ended = true;
        state.phase = MatchPhase.Ending;
        const reveals = buildReveals(state);
        const winnerIds = new Set(result.winners.map((p) => p.userId));
        const payload: S2CGameResult = {
          modeId: modeDef.id,
          reason: result.reason,
          summary: result.summary,
          reveals,
          winners: reveals.filter((r) => winnerIds.has(r.userId)),
        };
        broadcastGameResult(dispatcher, payload);
        refreshLabel(dispatcher, state);
        logger.info('round end: %s — %s', result.reason, result.summary);
      }
    }
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
    case OpCode.C2S_ATTACK:
      handleAttack(state, m, tick, dispatcher, logger);
      break;
    case OpCode.C2S_CHAT:
      handleChat(state, m, tick, dispatcher);
      break;
    case OpCode.C2S_TYPING_BEGIN:
      handleTyping(state, m, dispatcher, true);
      break;
    case OpCode.C2S_TYPING_END:
      handleTyping(state, m, dispatcher, false);
      break;
    case OpCode.C2S_SEARCH_CORPSE:
      handleSearchCorpse(state, m, dispatcher);
      break;
    case OpCode.C2S_TAKE_FROM_CORPSE:
      handleTakeFromCorpse(state, m, dispatcher);
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
  const modeDef = getMode(state.gameModeId);
  if (!modeDef) {
    sendError(dispatcher, m.sender, 'unknown_mode', `mode ${state.gameModeId} not registered`);
    return;
  }
  if (countPresences(state) < modeDef.minPlayers) {
    sendError(
      dispatcher,
      m.sender,
      'too_few_players',
      `${modeDef.displayName} needs ${modeDef.minPlayers}+`,
    );
    return;
  }
  state.phase = MatchPhase.InGame;
  assignSpawns(state);
  state.containers = seedContainers();
  state.groundItems = {};
  state.corpses = {};
  state.ended = false;
  // Mode engine: assign roles + grant starting items.
  assignRoles(state, modeDef);
  applyItemGrants(state, modeDef, logger);
  state.clock = newClock(state.tickN);
  broadcastPhaseChange(dispatcher, state);
  for (const userId in state.presences) {
    const p = state.presences[userId];
    const player = state.players[userId];
    if (p && player) {
      sendInvFull(dispatcher, state, p);
      sendRoleAssigned(dispatcher, p, player);
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
  if (tilemap.isDoor(nx, ny)) {
    const open: S2CDoorState = { x: nx, y: ny, open: true };
    dispatcher.broadcastMessage(OpCode.S2C_DOOR_STATE, JSON.stringify(open), null, null, true);
    // Auto-close after ~3s. Cheap setTimeout-equivalent: schedule by ticks.
    state.pendingDoorCloses ??= [];
    state.pendingDoorCloses.push({ x: nx, y: ny, closeAtTick: tick + TICK_RATE * 3 });
  }
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
  const r = addItem(player.inventory, ground.itemId, ground.count, ground.data);
  if (!r) return;
  player.inventory = r.inventory;
  delete state.groundItems[req.groundItemId];
  sendInvDelta(dispatcher, state, m.sender, { upserted: [r.instance], weight: r.inventory.weight });
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
  const r = removeItem(player.inventory, req.instanceId);
  if (!r) return;
  player.inventory = r.inventory;
  const ground = fromInstance(r.removed, player.x, player.y);
  state.groundItems[ground.groundItemId] = ground;
  sendInvDelta(dispatcher, state, m.sender, {
    removed: [req.instanceId],
    hotkeys: r.inventory.hotkeys,
    equipped: r.inventory.equipped,
    weight: r.inventory.weight,
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
  const e = setEquipped(player.inventory, req.instanceId);
  if (!e) {
    sendError(dispatcher, m.sender, 'no_such_instance', 'cannot equip');
    return;
  }
  player.inventory = e;
  sendInvDelta(dispatcher, state, m.sender, { equipped: e.equipped });
  // Broadcast a position update so other clients pick up the new
  // equippedItemId in the public view (no actual movement happened).
  broadcastPlayerMoved(dispatcher, player, state.tickN);
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
  const h = setHotkey(player.inventory, req.slot, req.instanceId);
  if (!h) {
    sendError(dispatcher, m.sender, 'no_such_instance', 'cannot bind hotkey');
    return;
  }
  player.inventory = h;
  sendInvDelta(dispatcher, state, m.sender, { hotkeys: h.hotkeys });
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
  logger.info('use: user=%s item=%s', player.userId, inst.itemId);
  // Item-specific use effects land here. Smoke bomb is the first wired one;
  // others (flashlight, syringe, …) follow as the engine adds support.
  if (inst.itemId === 'smoke_bomb') {
    const fx: S2CFxSmoke = { x: player.x, y: player.y, durationMs: 1500 };
    dispatcher.broadcastMessage(OpCode.S2C_FX_SMOKE, JSON.stringify(fx), null, null, true);
    // Consume one charge.
    const removed = removeItem(player.inventory, inst.instanceId);
    if (removed) {
      player.inventory = removed.inventory;
      sendInvFull(dispatcher, state, m.sender);
      return;
    }
  }
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
  const payload: S2CCraftResult = result.ok
    ? { ok: true, recipeId: req.recipeId, instanceId: result.output.instanceId }
    : { ok: false, recipeId: req.recipeId, error: result.error };
  dispatcher.broadcastMessage(
    OpCode.S2C_CRAFT_RESULT,
    JSON.stringify(payload),
    [m.sender],
    null,
    true,
  );
  if (result.ok) {
    player.inventory = result.inventory;
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
  const taken = c.contents.find((it) => it.instanceId === req.instanceId);
  if (!taken) return;
  const r = addItem(player.inventory, taken.itemId, taken.count, taken.data);
  if (!r) return;
  player.inventory = r.inventory;
  // Whole-array replacement (Goja proxy quirk).
  c.contents = c.contents.filter((it) => it.instanceId !== req.instanceId);
  sendInvDelta(dispatcher, state, m.sender, {
    upserted: [r.instance],
    weight: r.inventory.weight,
  });
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
  const r = removeItem(player.inventory, req.instanceId);
  if (!r) return;
  player.inventory = r.inventory;
  // Whole-array replacement (Goja proxy quirk).
  c.contents = [...c.contents, r.removed];
  sendInvDelta(dispatcher, state, m.sender, {
    removed: [req.instanceId],
    hotkeys: r.inventory.hotkeys,
    equipped: r.inventory.equipped,
    weight: r.inventory.weight,
  });
  sendContainerContents(dispatcher, m.sender, c);
}

// ---------- chat handlers ----------

function handleChat(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  tick: number,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const sender = state.players[m.sender.userId];
  if (!sender) return;
  const req = parseBody<C2SChat>(m.data);
  if (!req || !req.channel) return;
  const body = sanitizeChatBody(req.body);
  if (body.length === 0) return;

  const { recipients, bubble } = routeChat(state, sender, req.channel);
  if (recipients.length === 0) return;

  const payload: S2CChatMessage = {
    channel: req.channel,
    fromUserId: sender.userId,
    fromUsername: sender.username,
    body,
    bubble,
    tickN: tick,
  };
  dispatcher.broadcastMessage(
    OpCode.S2C_CHAT_MESSAGE,
    JSON.stringify(payload),
    recipients,
    null,
    true,
  );
}

function handleTyping(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
  active: boolean,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const sender = state.players[m.sender.userId];
  if (!sender) return;
  const req = parseBody<C2STypingBegin | C2STypingEnd>(m.data);
  if (!req || !req.channel) return;

  // Use the same proximity rules as the chat itself; typing indicators on
  // OOC / dead are dropped (too noisy).
  const { recipients } = routeChat(state, sender, req.channel);
  if (recipients.length === 0) return;
  const payload: S2CTyping = {
    fromUserId: sender.userId,
    channel: req.channel,
    active,
  };
  dispatcher.broadcastMessage(OpCode.S2C_TYPING, JSON.stringify(payload), recipients, null, true);
}

// ---------- combat + corpse handlers ----------

function handleAttack(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  tick: number,
  dispatcher: nkruntime.MatchDispatcher,
  logger: nkruntime.Logger,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const attacker = state.players[m.sender.userId];
  if (!attacker || !attacker.isAlive) return;

  const req = parseBody<C2SAttack>(m.data) ?? {};
  if (req.dir) attacker.facing = req.dir as Facing;

  const result = resolveAttack(state, attacker, tick, req.dir as Facing | undefined);
  if (!result.swung) return;

  // Self-only stamina + facing snapshot.
  sendStamina(dispatcher, m.sender, attacker);
  // We send the attacker's facing as a movement broadcast so other clients
  // turn the sprite to face the swing direction. Coordinates unchanged.
  broadcastPlayerMoved(dispatcher, attacker, tick);

  if (!result.hitUserId) return;
  const victim = state.players[result.hitUserId];
  if (!victim) return;

  broadcastPlayerHealth(dispatcher, victim);
  // Self-only HP detail to the victim's HUD.
  const victimPresence = state.presences[victim.userId];
  if (victimPresence) sendPlayerHP(dispatcher, victimPresence, victim);

  if (result.killed && result.corpse) {
    state.corpses[result.corpse.corpseId] = result.corpse;
    broadcastPlayerDied(dispatcher, victim, attacker.userId, result.weaponName);
    broadcastCorpseUpdate(dispatcher, result.corpse);
    // Killer + corpse are both visible to anyone with line of sight; the
    // body-discovery flow will fire on someone else walking adjacent.
    logger.info(
      'kill: %s killed %s with %s at (%d,%d)',
      attacker.username,
      victim.username,
      result.weaponName,
      victim.x,
      victim.y,
    );
  }
}

function handleSearchCorpse(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  const req = parseBody<C2SSearchCorpse>(m.data);
  if (!req) return;
  const c = state.corpses[req.corpseId];
  if (!c) return;
  if (Math.max(Math.abs(player.x - c.x), Math.abs(player.y - c.y)) > 1) {
    sendError(dispatcher, m.sender, 'too_far', 'corpse not adjacent');
    return;
  }
  const payload: S2CCorpseContents = { corpseId: c.corpseId, contents: c.contents };
  dispatcher.broadcastMessage(
    OpCode.S2C_CORPSE_CONTENTS,
    JSON.stringify(payload),
    [m.sender],
    null,
    true,
  );
}

function handleTakeFromCorpse(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  const req = parseBody<C2STakeFromCorpse>(m.data);
  if (!req) return;
  const c = state.corpses[req.corpseId];
  if (!c) return;
  if (Math.max(Math.abs(player.x - c.x), Math.abs(player.y - c.y)) > 1) return;
  const taken = c.contents.find((it) => it.instanceId === req.instanceId);
  if (!taken) return;
  const added = addItem(player.inventory, taken.itemId, taken.count, taken.data);
  if (!added) return;
  player.inventory = added.inventory;
  c.contents = c.contents.filter((it) => it.instanceId !== req.instanceId);
  sendInvDelta(dispatcher, state, m.sender, {
    upserted: [added.instance],
    weight: added.inventory.weight,
  });
  // Echo the corpse contents so the client UI updates.
  const payload: S2CCorpseContents = { corpseId: c.corpseId, contents: c.contents };
  dispatcher.broadcastMessage(
    OpCode.S2C_CORPSE_CONTENTS,
    JSON.stringify(payload),
    [m.sender],
    null,
    true,
  );
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
  const equippedInst = player.inventory.equipped
    ? player.inventory.items.find((i) => i.instanceId === player.inventory.equipped)
    : null;
  const payload: S2CPlayerMoved = {
    userId: player.userId,
    x: player.x,
    y: player.y,
    facing: player.facing,
    tickN: tick,
    equippedItemId: equippedInst?.itemId ?? null,
    equippedItemBloody: equippedInst?.data?.['bloody'] === true,
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

function sendStamina(
  dispatcher: nkruntime.MatchDispatcher,
  recipient: nkruntime.Presence,
  player: PlayerInGame,
): void {
  const payload: S2CPlayerStamina = { stamina: player.stamina, maxStamina: player.maxStamina };
  dispatcher.broadcastMessage(
    OpCode.S2C_PLAYER_STAMINA,
    JSON.stringify(payload),
    [recipient],
    null,
    true,
  );
}

function sendPlayerHP(
  dispatcher: nkruntime.MatchDispatcher,
  recipient: nkruntime.Presence,
  player: PlayerInGame,
): void {
  const payload: S2CPlayerHP = { hp: player.hp, maxHp: player.maxHp };
  dispatcher.broadcastMessage(
    OpCode.S2C_PLAYER_HP,
    JSON.stringify(payload),
    [recipient],
    null,
    true,
  );
}

function broadcastPlayerHealth(dispatcher: nkruntime.MatchDispatcher, player: PlayerInGame): void {
  const payload: S2CPlayerHealth = {
    userId: player.userId,
    hp: player.hp,
    maxHp: player.maxHp,
    isAlive: player.isAlive,
  };
  dispatcher.broadcastMessage(OpCode.S2C_PLAYER_HEALTH, JSON.stringify(payload), null, null, true);
}

function broadcastPlayerDied(
  dispatcher: nkruntime.MatchDispatcher,
  victim: PlayerInGame,
  killerUserId: string | null,
  cause: string,
): void {
  const payload: S2CPlayerDied = {
    userId: victim.userId,
    killerUserId,
    cause,
    x: victim.x,
    y: victim.y,
  };
  dispatcher.broadcastMessage(OpCode.S2C_PLAYER_DIED, JSON.stringify(payload), null, null, true);
}

function broadcastCorpseUpdate(dispatcher: nkruntime.MatchDispatcher, c: Corpse): void {
  const pub: PublicCorpse = {
    corpseId: c.corpseId,
    victimUserId: c.victimUserId,
    victimUsername: c.victimUsername,
    // Real name only revealed once the body has been discovered.
    victimRealName: c.discovered ? c.victimRealName : '',
    x: c.x,
    y: c.y,
    discovered: c.discovered,
    ...(c.discoveredByUserId ? { discoveredByUserId: c.discoveredByUserId } : {}),
  };
  const payload: S2CCorpseSpawn = { corpse: pub };
  dispatcher.broadcastMessage(OpCode.S2C_CORPSE_SPAWN, JSON.stringify(payload), null, null, true);
}

function broadcastAnnouncement(
  dispatcher: nkruntime.MatchDispatcher,
  payload: S2CAnnouncement,
): void {
  dispatcher.broadcastMessage(OpCode.S2C_ANNOUNCEMENT, JSON.stringify(payload), null, null, true);
}

function sendRoleAssigned(
  dispatcher: nkruntime.MatchDispatcher,
  recipient: nkruntime.Presence,
  player: PlayerInGame,
): void {
  const role = ROLES[player.roleId as RoleId];
  const payload: S2CRoleAssigned = {
    roleId: player.roleId as RoleId,
    roleName: role.name,
    description: role.description,
    realName: player.realName,
  };
  dispatcher.broadcastMessage(
    OpCode.S2C_PLAYER_ROLE_ASSIGNED,
    JSON.stringify(payload),
    [recipient],
    null,
    true,
  );
}

function broadcastClock(
  dispatcher: nkruntime.MatchDispatcher,
  formatted: ReturnType<typeof formatGameClock>,
): void {
  const payload: S2CClockTick = {
    gameHour: formatted.hour12,
    ampm: formatted.ampm,
    hoursLeft: formatted.hoursLeft,
  };
  dispatcher.broadcastMessage(OpCode.S2C_CLOCK_TICK, JSON.stringify(payload), null, null, true);
}

function broadcastGameResult(dispatcher: nkruntime.MatchDispatcher, payload: S2CGameResult): void {
  dispatcher.broadcastMessage(OpCode.S2C_GAME_RESULT, JSON.stringify(payload), null, null, true);
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
