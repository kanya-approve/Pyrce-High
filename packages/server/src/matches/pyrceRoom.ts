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
  type C2SDoorToggle,
  type C2SDoppelgangerCopy,
  type C2SDragCorpse,
  type C2SInvCraft,
  type C2SInvDrop,
  type C2SInvEquip,
  type C2SInvPickup,
  type C2SInvSetHotkey,
  type C2SInvUse,
  type C2SLobbyStartGame,
  type C2SMoveIntent,
  type C2SSearchConsent,
  type C2SSearchCorpse,
  type C2STakeFromCorpse,
  type C2SVampireDrain,
  type C2SVendingBuy,
  type C2SViewProfile,
  type C2SVoteEndGame,
  type C2SVoteKick,
  type C2SVoteMode,
  DIRECTION_DELTAS,
  type Facing,
  type GameModeId,
  getMode,
  ITEMS,
  type ItemInstanceId,
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
  type S2CFxButterfly,
  type S2CFxFeather,
  type S2CFxSmoke,
  type S2CFxSound,
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
  type S2CProfileView,
  type S2CRoleAssigned,
  type S2CSearchDenied,
  type S2CSearchRequest,
  type S2CSelfRoleState,
  type S2CStudentRoster,
  type S2CVoteEndGameTally,
  type S2CVoteKickTally,
  type S2CVoteModeTally,
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
import { MODE_SCRIPTS } from '../modeScripts.js';
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
  RECONNECT_GRACE_TICKS,
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
    // Re-joining player: clear the disconnect timer so they're safe again.
    const player = state.players[p.userId];
    if (player?.disconnectedAtTick !== undefined) {
      delete player.disconnectedAtTick;
    }
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
  tick: number,
  state: PyrceMatchState,
  presences: nkruntime.Presence[],
): { state: PyrceMatchState } {
  for (const p of presences) {
    delete state.presences[p.userId];
    if (state.phase === MatchPhase.Lobby) {
      delete state.players[p.userId];
    } else if (state.phase === MatchPhase.InGame) {
      // Stamp the disconnect tick. matchLoop kills the player if they're
      // still gone after RECONNECT_GRACE_TICKS so the round can resolve.
      const player = state.players[p.userId];
      if (player && player.isAlive) player.disconnectedAtTick = tick;
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

  // Mode-script per-tick scheduler drain (death-note kills, witch revives,
  // zombie infections turning).
  drainScheduledEffects(state, dispatcher, tick, logger);

  // Reap players whose presence has been gone too long.
  reapStaleDisconnects(state, dispatcher, tick, logger);

  // Mode-script onTick hook.
  const modeScript = state.gameModeId
    ? MODE_SCRIPTS[getMode(effectiveModeId(state))?.scriptId ?? '']
    : undefined;
  modeScript?.onTick?.(state, { tick, tickRate: TICK_RATE });

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
    const modeDef = getMode(effectiveModeId(state));
    if (modeDef) {
      const result = evaluateWinConditions(state, modeDef, gameMinutes);
      if (result) {
        state.ended = true;
        state.phase = MatchPhase.Ending;
        const reveals = buildReveals(state);
        const winnerIds = new Set(result.winners.map((p) => p.userId));
        const summary = state.secretActualModeId
          ? `Secret was actually ${getMode(state.secretActualModeId)?.displayName ?? state.secretActualModeId}. ${result.summary}`
          : result.summary;
        const payload: S2CGameResult = {
          modeId: (state.gameModeId ?? modeDef.id) as GameModeId,
          reason: result.reason,
          summary,
          reveals,
          winners: reveals.filter((r) => winnerIds.has(r.userId)),
        };
        broadcastGameResult(dispatcher, payload);
        refreshLabel(dispatcher, state);
        logger.info('round end: %s — %s', result.reason, summary);
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
    case OpCode.C2S_SEARCH_CONSENT:
      handleSearchConsent(state, m, dispatcher);
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
    case OpCode.C2S_DOOR_TOGGLE:
      handleDoorToggle(state, m, dispatcher);
      break;
    case OpCode.C2S_VENDING_BUY:
      handleVendingBuy(state, m, dispatcher);
      break;
    case OpCode.C2S_VOTE_MODE:
      handleVoteMode(state, m, dispatcher);
      break;
    case OpCode.C2S_VOTE_END_GAME:
      handleVoteEndGame(state, m, dispatcher, logger);
      break;
    case OpCode.C2S_VOTE_KICK:
      handleVoteKick(state, m, tick, dispatcher, logger);
      break;
    case OpCode.C2S_VIEW_PROFILE:
      handleViewProfile(state, m, dispatcher);
      break;
    case OpCode.C2S_DRAG_CORPSE:
      handleDragCorpse(state, m, dispatcher);
      break;
    case OpCode.C2S_DOPPELGANGER_COPY:
      handleDoppelgangerCopy(state, m, tick, dispatcher);
      break;
    case OpCode.C2S_VAMPIRE_DRAIN:
      handleVampireDrain(state, m, dispatcher);
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
  // If host didn't specify, pick the lobby vote leader (ties broken by id).
  state.gameModeId = req.gameModeId ?? leadingMode(state) ?? 'normal';
  // Secret mode swaps in a random concrete mode under the hood per
  // GameStarter.dm:255-258 — clients still see modeId 'secret' until
  // end-game reveal.
  delete state.secretActualModeId;
  if (state.gameModeId === 'secret') {
    const pool = [
      'normal',
      'witch',
      'zombie',
      'doppelganger',
      'ghost',
      'vampire',
      'death_note_classic',
      'extended',
    ];
    state.secretActualModeId = pool[Math.floor(Math.random() * pool.length)] ?? 'normal';
    logger.info('secret mode resolved underlying mode=%s', state.secretActualModeId);
  }
  const modeDef = getMode(effectiveModeId(state));
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
  state.modeVotes = {};
  state.endGameVotes = {};
  assignSpawns(state);
  state.containers = seedContainers();
  state.groundItems = {};
  state.corpses = {};
  state.ended = false;
  // Mode engine: assign roles + grant starting items.
  assignRoles(state, modeDef);
  applyItemGrants(state, modeDef, logger);
  relocateSpecialSpawns(state);
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
    broadcastPlayerMoved(dispatcher, player, tick, state);
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
  broadcastPlayerMoved(dispatcher, player, tick, state);
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
  broadcastPlayerMoved(dispatcher, player, state.tickN, state);
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
  const def = ITEMS[inst.itemId];
  const kind = def?.use?.kind;
  logger.info('use: user=%s item=%s kind=%s', player.userId, inst.itemId, kind ?? 'none');

  switch (kind) {
    case 'smoke_bomb': {
      const fx: S2CFxSmoke = { x: player.x, y: player.y, durationMs: 1500 };
      dispatcher.broadcastMessage(OpCode.S2C_FX_SMOKE, JSON.stringify(fx), null, null, true);
      broadcastFxSound(dispatcher, 'smallexplosion', player.x, player.y, 0.7);
      consumeCharge(state, dispatcher, m.sender, player, inst.instanceId);
      return;
    }
    case 'first_aid': {
      // Heals about half of any missing HP — DM's `Heal()` proc.
      const missing = player.maxHp - player.hp;
      if (missing <= 0) {
        sendError(dispatcher, m.sender, 'full_hp', 'already at full health');
        return;
      }
      const healed = Math.max(1, Math.floor(missing / 2) + 25);
      player.hp = Math.min(player.maxHp, player.hp + healed);
      sendPlayerHP(dispatcher, m.sender, player);
      consumeCharge(state, dispatcher, m.sender, player, inst.instanceId);
      return;
    }
    case 'drink_soda': {
      // +10..60 stamina (DM Vars.dm: stamina += rand(10,60)).
      const restore = 10 + Math.floor(Math.random() * 51);
      player.stamina = Math.min(player.maxStamina, player.stamina + restore);
      sendStamina(dispatcher, m.sender, player);
      consumeCharge(state, dispatcher, m.sender, player, inst.instanceId);
      return;
    }
    case 'popper_trap': {
      // Drops a smoke + announce. Trap behaviour proper is a M-future; for now
      // it puffs at the player's tile and consumes the charge.
      const fx: S2CFxSmoke = { x: player.x, y: player.y, durationMs: 2500 };
      dispatcher.broadcastMessage(OpCode.S2C_FX_SMOKE, JSON.stringify(fx), null, null, true);
      consumeCharge(state, dispatcher, m.sender, player, inst.instanceId);
      return;
    }
    case 'key_card_swipe': {
      // Open the closest door within Chebyshev 1 — DM's `Swipe()` verb.
      const door = findAdjacentDoor(player.x, player.y);
      if (!door) {
        sendError(dispatcher, m.sender, 'no_door', 'no door adjacent');
        return;
      }
      const open: S2CDoorState = { x: door.x, y: door.y, open: true };
      dispatcher.broadcastMessage(OpCode.S2C_DOOR_STATE, JSON.stringify(open), null, null, true);
      state.pendingDoorCloses ??= [];
      state.pendingDoorCloses.push({
        x: door.x,
        y: door.y,
        closeAtTick: state.tickN + TICK_RATE * 5,
      });
      sendInvDelta(dispatcher, state, m.sender, {});
      return;
    }
    case 'fill_syringe': {
      // Mark the inst's data with the payload. Doesn't consume — the syringe
      // is what gets injected. DM's `Mix()` verb on the consumable.
      const payload = def?.use && 'payload' in def.use ? def.use.payload : undefined;
      const updated = {
        ...inst,
        data: { ...(inst.data ?? {}), filled: payload ?? 'unknown' },
      };
      player.inventory = {
        ...player.inventory,
        items: player.inventory.items.map((it) =>
          it.instanceId === inst.instanceId ? updated : it,
        ),
      };
      sendInvDelta(dispatcher, state, m.sender, { upserted: [updated] });
      return;
    }
    case 'syringe': {
      // Inject self with whatever's filled. Only Cure does anything visible
      // for v1 — others follow when the matching status effects land.
      const filled = inst.data?.['filled'];
      if (!filled) {
        sendError(dispatcher, m.sender, 'empty_syringe', 'fill the syringe first');
        return;
      }
      if (filled === 'Regenerative') {
        player.hp = Math.min(player.maxHp, player.hp + 30);
        sendPlayerHP(dispatcher, m.sender, player);
      }
      // Cure / Sedative status effects are no-ops until the buff system lands.
      consumeCharge(state, dispatcher, m.sender, player, inst.instanceId);
      return;
    }
    case 'flashlight':
    case 'glasses_toggle': {
      // Toggle a per-instance `on` flag. Lighting picks up flashlight via
      // ITEMS.lightRadius today; the toggle ramps that conditionally.
      const updated = {
        ...inst,
        data: { ...(inst.data ?? {}), on: !inst.data?.['on'] },
      };
      player.inventory = {
        ...player.inventory,
        items: player.inventory.items.map((it) =>
          it.instanceId === inst.instanceId ? updated : it,
        ),
      };
      sendInvDelta(dispatcher, state, m.sender, { upserted: [updated] });
      return;
    }
    case 'death_note_write': {
      // Forwarded to the active mode's script (death_note / death_note_classic).
      // The C2S_INV_USE payload includes a `targetUserId` selected by the
      // Kira UI; the script schedules the heart-attack timer.
      if (player.roleId !== 'kira') {
        sendError(dispatcher, m.sender, 'not_kira', 'only Kira can write the death note');
        return;
      }
      const useReq = req as C2SInvUse & { targetUserId?: string };
      const modeDef2 = getMode(effectiveModeId(state));
      const script = modeDef2?.scriptId ? MODE_SCRIPTS[modeDef2.scriptId] : undefined;
      if (!script?.onUse) {
        sendError(dispatcher, m.sender, 'wrong_mode', 'death note only works in Death Note mode');
        return;
      }
      script.onUse(
        state,
        player,
        inst.instanceId,
        { targetUserId: useReq.targetUserId },
        { tick: state.tickN, tickRate: TICK_RATE },
      );
      sendInvDelta(dispatcher, state, m.sender, {});
      return;
    }
    case 'computer': {
      // School Computer (DM `School Computer.dm`): show the student roster
      // — name + condition for every player. Originally split per classroom
      // with hair colors + PDA numbers; we don't model those, so we just
      // dump the alive list.
      const entries: S2CStudentRoster['entries'] = [];
      for (const uid in state.players) {
        const p = state.players[uid];
        if (!p) continue;
        entries.push({
          userId: p.userId,
          username: p.username,
          isAlive: p.isAlive,
          condition: describeCondition(p),
        });
      }
      const payload: S2CStudentRoster = { entries };
      dispatcher.broadcastMessage(
        OpCode.S2C_STUDENT_ROSTER,
        JSON.stringify(payload),
        [m.sender],
        null,
        true,
      );
      sendInvDelta(dispatcher, state, m.sender, {});
      return;
    }
    case 'feather_shoot': {
      // Black Feather (DM `Black Feather.dm` Dragon_Shoot): consume the
      // feather, fire a projectile in the facing direction up to range
      // FEATHER_RANGE; first alive player along the line takes a lethal hit.
      const FEATHER_RANGE = 8;
      const delta = DIRECTION_DELTAS[player.facing];
      const path: Array<{ x: number; y: number }> = [];
      let hitVictim: PlayerInGame | null = null;
      if (delta) {
        for (let step = 1; step <= FEATHER_RANGE; step++) {
          const tx = player.x + delta.dx * step;
          const ty = player.y + delta.dy * step;
          if (!tilemap.isPassable(tx, ty)) break;
          path.push({ x: tx, y: ty });
          for (const otherId in state.players) {
            const o = state.players[otherId];
            if (!o || o === player || !o.isAlive) continue;
            if (o.x === tx && o.y === ty) {
              hitVictim = o;
              break;
            }
          }
          if (hitVictim) break;
        }
      }
      // Broadcast the visual + sound regardless of hit.
      const fxPayload: S2CFxFeather = { path };
      dispatcher.broadcastMessage(
        OpCode.S2C_FX_FEATHER,
        JSON.stringify(fxPayload),
        null,
        null,
        true,
      );
      broadcastFxSound(dispatcher, 'birdflap', player.x, player.y, 0.8);
      // Apply the kill if we hit someone.
      if (hitVictim) {
        hitVictim.hp = 0;
        hitVictim.isAlive = false;
        hitVictim.isWatching = true;
        const corpse: Corpse = {
          corpseId: newCorpseId(),
          victimUserId: hitVictim.userId,
          victimUsername: hitVictim.username,
          victimRealName: hitVictim.realName,
          killerUserId: player.userId,
          cause: 'Black Feather',
          x: hitVictim.x,
          y: hitVictim.y,
          contents: hitVictim.inventory.items.slice(),
          discovered: false,
          discoveredByUserId: null,
        };
        hitVictim.inventory = {
          items: [],
          hotkeys: [null, null, null, null, null],
          equipped: null,
          weight: 0,
          weightCap: hitVictim.inventory.weightCap,
        };
        state.corpses[corpse.corpseId] = corpse;
        broadcastPlayerDied(dispatcher, hitVictim, player.userId, 'Black Feather');
        broadcastCorpseUpdate(dispatcher, corpse);
        broadcastFxSound(dispatcher, 'body_fall', hitVictim.x, hitVictim.y, 0.7);
      }
      consumeCharge(state, dispatcher, m.sender, player, inst.instanceId);
      return;
    }
    // Stub: notify the user but don't crash. These need full mode support
    // (paper-airplane needs target picker, PDA needs full roster) — wired
    // when modes ship.
    case 'paper_write':
    case 'paper_airplane':
    case 'paper_view':
    case 'pda':
    case 'door_code_view': {
      sendError(
        dispatcher,
        m.sender,
        'not_yet_implemented',
        `${def?.name ?? inst.itemId}: stub — landing with role/mode work`,
      );
      sendInvDelta(dispatcher, state, m.sender, {});
      return;
    }
    default:
      sendInvDelta(dispatcher, state, m.sender, {});
      return;
  }
}

/** Remove one instance from the player's inventory and broadcast the delta. */
function consumeCharge(
  state: PyrceMatchState,
  dispatcher: nkruntime.MatchDispatcher,
  sender: nkruntime.Presence,
  player: PlayerInGame,
  instanceId: ItemInstanceId,
): void {
  const removed = removeItem(player.inventory, instanceId);
  if (!removed) return;
  player.inventory = removed.inventory;
  sendInvFull(dispatcher, state, sender);
}

// ---------- body interactions ----------

/** Mirrors DM `Verbs.dm:181` View_Profile (oview 7). */
function handleViewProfile(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const viewer = state.players[m.sender.userId];
  if (!viewer) return;
  const req = parseBody<C2SViewProfile>(m.data);
  if (!req) return;
  const target = state.players[req.userId];
  if (!target) return;
  const dx = Math.abs(target.x - viewer.x);
  const dy = Math.abs(target.y - viewer.y);
  if (Math.max(dx, dy) > 7) {
    sendError(dispatcher, m.sender, 'too_far', 'profile is out of range');
    return;
  }
  const condition = describeCondition(target);
  const payload: S2CProfileView = {
    userId: target.userId,
    username: target.username,
    hp: target.hp,
    maxHp: target.maxHp,
    isAlive: target.isAlive,
    condition,
  };
  dispatcher.broadcastMessage(
    OpCode.S2C_PROFILE_VIEW,
    JSON.stringify(payload),
    [m.sender],
    null,
    true,
  );
}

function describeCondition(p: PlayerInGame): string {
  if (!p.isAlive) return 'Dead';
  const ratio = p.maxHp > 0 ? p.hp / p.maxHp : 0;
  if (ratio > 0.99) return 'Perfect';
  if (ratio > 0.7) return 'Fine';
  if (ratio > 0.6) return 'Hurt';
  if (ratio > 0.4) return 'Badly Wounded';
  if (ratio > 0.2) return 'Severely Injured';
  return 'Dying…';
}

/** Drag a corpse one tile in the dragger's facing direction. */
function handleDragCorpse(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  const req = parseBody<C2SDragCorpse>(m.data);
  if (!req) return;
  const corpse = state.corpses[req.corpseId];
  if (!corpse) return;
  const dx = Math.abs(corpse.x - player.x);
  const dy = Math.abs(corpse.y - player.y);
  if (Math.max(dx, dy) > 1) {
    sendError(dispatcher, m.sender, 'too_far', 'corpse not adjacent');
    return;
  }
  const delta = DIRECTION_DELTAS[player.facing];
  if (!delta) return;
  const nx = corpse.x + delta.dx;
  const ny = corpse.y + delta.dy;
  if (!tilemap.isPassable(nx, ny)) return;
  corpse.x = nx;
  corpse.y = ny;
  broadcastCorpseUpdate(dispatcher, corpse);
}

/**
 * Vampire: drain blood from an adjacent corpse for +30 HP. One drain per
 * corpse — `corpse.drained=true` blocks repeats.
 */
const VAMPIRE_DRAIN_HEAL = 30;

function handleVampireDrain(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  if (player.roleId !== 'vampire') {
    sendError(dispatcher, m.sender, 'wrong_role', 'only the Vampire can drain a corpse');
    return;
  }
  const req = parseBody<C2SVampireDrain>(m.data);
  if (!req) return;
  const corpse = state.corpses[req.corpseId];
  if (!corpse) return;
  if (corpse.drained) {
    sendError(dispatcher, m.sender, 'already_drained', 'this body has been drained');
    return;
  }
  if (Math.max(Math.abs(corpse.x - player.x), Math.abs(corpse.y - player.y)) > 1) {
    sendError(dispatcher, m.sender, 'too_far', 'corpse not adjacent');
    return;
  }
  corpse.drained = true;
  player.hp = Math.min(player.maxHp, player.hp + VAMPIRE_DRAIN_HEAL);
  player.roleData = {
    ...(player.roleData ?? {}),
    drained: ((player.roleData?.['drained'] as number | undefined) ?? 0) + 1,
  };
  broadcastPlayerHealth(dispatcher, player);
  sendPlayerHP(dispatcher, m.sender, player);
  sendSelfRoleState(dispatcher, m.sender, player);
  broadcastCorpseUpdate(dispatcher, corpse);
}

/**
 * Doppelganger: copy an adjacent corpse's appearance. The disguise persists
 * until the doppel attacks (DM `Doppelganger.dm` Reveal_On_Attack hook;
 * we drop it on attack in resolveAttack indirectly via roleData clearing).
 */
function handleDoppelgangerCopy(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  tick: number,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  if (player.roleId !== 'doppelganger') {
    sendError(dispatcher, m.sender, 'wrong_role', 'only the Doppelganger can copy a corpse');
    return;
  }
  const req = parseBody<C2SDoppelgangerCopy>(m.data);
  if (!req) return;
  const corpse = state.corpses[req.corpseId];
  if (!corpse) return;
  if (Math.max(Math.abs(corpse.x - player.x), Math.abs(corpse.y - player.y)) > 1) {
    sendError(dispatcher, m.sender, 'too_far', 'corpse not adjacent');
    return;
  }
  player.roleData = {
    ...(player.roleData ?? {}),
    disguiseAsUserId: corpse.victimUserId,
    disguiseUsername: corpse.victimUsername,
  };
  broadcastPlayerMoved(dispatcher, player, tick, state);
}

// ---------- voting ----------

function handleVoteMode(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.Lobby) return;
  const req = parseBody<C2SVoteMode>(m.data);
  if (!req) return;
  state.modeVotes ??= {};
  if (req.modeId === null || req.modeId === '') {
    delete state.modeVotes[m.sender.userId];
  } else if (getMode(req.modeId)) {
    state.modeVotes[m.sender.userId] = req.modeId;
  } else {
    sendError(dispatcher, m.sender, 'unknown_mode', `mode ${req.modeId} not registered`);
    return;
  }
  broadcastModeTally(dispatcher, state);
}

function broadcastModeTally(dispatcher: nkruntime.MatchDispatcher, state: PyrceMatchState): void {
  const tally: { [modeId: string]: number } = {};
  for (const userId in state.modeVotes ?? {}) {
    const m = state.modeVotes?.[userId];
    if (m) tally[m] = (tally[m] ?? 0) + 1;
  }
  const payload: S2CVoteModeTally = {
    tally,
    voted: Object.keys(state.modeVotes ?? {}).length,
    total: countPresences(state),
  };
  dispatcher.broadcastMessage(
    OpCode.S2C_VOTE_MODE_TALLY,
    JSON.stringify(payload),
    null,
    null,
    true,
  );
}

/** What mode is *actually* running this round (Secret mode unwraps to its pick). */
function effectiveModeId(state: PyrceMatchState): string {
  return state.secretActualModeId ?? state.gameModeId ?? '';
}

function handleVoteKick(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  tick: number,
  dispatcher: nkruntime.MatchDispatcher,
  logger: nkruntime.Logger,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const voter = state.players[m.sender.userId];
  if (!voter || !voter.isAlive) return;
  const req = parseBody<C2SVoteKick>(m.data);
  if (!req) return;
  state.kickVotes ??= {};
  // Withdraw any prior kick vote this voter has cast.
  for (const t in state.kickVotes) {
    delete state.kickVotes[t]?.[m.sender.userId];
    if (state.kickVotes[t] && Object.keys(state.kickVotes[t]).length === 0) {
      delete state.kickVotes[t];
    }
  }
  if (req.targetUserId && state.players[req.targetUserId]) {
    if (!state.kickVotes[req.targetUserId]) state.kickVotes[req.targetUserId] = {};
    const bucket = state.kickVotes[req.targetUserId];
    if (bucket) bucket[m.sender.userId] = true;
  }
  // Compute alive denominator.
  let alive = 0;
  for (const uid in state.players) if (state.players[uid]?.isAlive) alive++;
  // Broadcast a tally for whichever target this voter is now backing
  // (or all active targets if you withdrew from one and didn't pick another).
  const activeTargets = req.targetUserId ? [req.targetUserId] : Object.keys(state.kickVotes);
  for (const target of activeTargets) {
    const votes = state.kickVotes[target];
    if (!votes) continue;
    const yes = Object.keys(votes).length;
    const resolved = alive > 0 && yes * 2 > alive;
    const targetPlayer = state.players[target];
    const payload: S2CVoteKickTally = {
      targetUserId: target,
      targetUsername: targetPlayer?.username ?? '?',
      yes,
      alive,
      resolved,
    };
    dispatcher.broadcastMessage(
      OpCode.S2C_VOTE_KICK_TALLY,
      JSON.stringify(payload),
      null,
      null,
      true,
    );
    if (resolved && targetPlayer && targetPlayer.isAlive) {
      // Force-kill via the same path as the disconnect reaper.
      targetPlayer.hp = 0;
      targetPlayer.isAlive = false;
      targetPlayer.isWatching = true;
      const corpse: Corpse = {
        corpseId: newCorpseId(),
        victimUserId: targetPlayer.userId,
        victimUsername: targetPlayer.username,
        victimRealName: targetPlayer.realName,
        killerUserId: null,
        cause: 'Vote-Kicked',
        x: targetPlayer.x,
        y: targetPlayer.y,
        contents: targetPlayer.inventory.items.slice(),
        discovered: false,
        discoveredByUserId: null,
      };
      targetPlayer.inventory = {
        items: [],
        hotkeys: [null, null, null, null, null],
        equipped: null,
        weight: 0,
        weightCap: targetPlayer.inventory.weightCap,
      };
      state.corpses[corpse.corpseId] = corpse;
      broadcastPlayerDied(dispatcher, targetPlayer, null, 'Vote-Kicked');
      broadcastCorpseUpdate(dispatcher, corpse);
      broadcastAnnouncement(dispatcher, {
        kind: 'system',
        message: `${targetPlayer.username} was vote-kicked from the round.`,
      });
      delete state.kickVotes[target];
      logger.info('vote-kick: %s removed (%d/%d voted)', target, yes, alive);
      // Also drop their presence so they leave the match.
      const pres = state.presences[target];
      if (pres) {
        dispatcher.matchKick([pres]);
      }
      // Touched a different player; refresh their visual state.
      broadcastPlayerMoved(dispatcher, targetPlayer, tick, state);
    }
  }
}

function leadingMode(state: PyrceMatchState): string | null {
  const tally: { [modeId: string]: number } = {};
  for (const userId in state.modeVotes ?? {}) {
    const m = state.modeVotes?.[userId];
    if (m) tally[m] = (tally[m] ?? 0) + 1;
  }
  let bestId: string | null = null;
  let bestN = 0;
  for (const id in tally) {
    const n = tally[id] ?? 0;
    if (n > bestN || (n === bestN && bestId !== null && id < bestId)) {
      bestN = n;
      bestId = id;
    }
  }
  return bestId;
}

function handleVoteEndGame(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
  logger: nkruntime.Logger,
): void {
  if (state.phase !== MatchPhase.InGame || state.ended) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  const req = parseBody<C2SVoteEndGame>(m.data);
  if (!req) return;
  state.endGameVotes ??= {};
  if (req.vote) state.endGameVotes[m.sender.userId] = true;
  else delete state.endGameVotes[m.sender.userId];

  let alive = 0;
  for (const uid in state.players) if (state.players[uid]?.isAlive) alive++;
  const yes = Object.keys(state.endGameVotes).length;
  // Strict majority of alive players.
  const resolved = alive > 0 && yes * 2 > alive;
  const payload: S2CVoteEndGameTally = { yes, alive, resolved };
  dispatcher.broadcastMessage(
    OpCode.S2C_VOTE_END_GAME_TALLY,
    JSON.stringify(payload),
    null,
    null,
    true,
  );
  if (resolved) {
    state.ended = true;
    state.phase = MatchPhase.Ending;
    const reveals = buildReveals(state);
    const summary = state.secretActualModeId
      ? `Round ended by player vote. Secret was actually ${getMode(state.secretActualModeId)?.displayName ?? state.secretActualModeId}.`
      : 'Round ended by player vote.';
    const result: S2CGameResult = {
      modeId: (state.gameModeId ?? 'normal') as GameModeId,
      reason: 'end_game_vote',
      summary,
      reveals,
      winners: [],
    };
    broadcastGameResult(dispatcher, result);
    refreshLabel(dispatcher, state);
    logger.info('round end via end-game vote (%d/%d alive voted yes)', yes, alive);
  }
}

/**
 * Vending machine: spend 100 yen for one soda. DM `turf.dm:78-94` —
 * vending1.dmi soda machine. The other vending sprites (vending2, vending3)
 * exist as placeable cosmetics in DM and are accepted here as a no-op.
 */
const VENDING_COST_YEN = 100;

function handleVendingBuy(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  const req = parseBody<C2SVendingBuy>(m.data);
  if (!req) return;
  // Adjacent check.
  if (Math.max(Math.abs(player.x - req.x), Math.abs(player.y - req.y)) > 1) {
    sendError(dispatcher, m.sender, 'too_far', 'vending machine not adjacent');
    return;
  }
  // Confirm there's an actual vending machine on that tile.
  const machine = (tilemap.raw.vendings ?? []).find((v) => v.x === req.x && v.y === req.y);
  if (!machine) {
    sendError(dispatcher, m.sender, 'no_vending', 'no vending machine here');
    return;
  }
  // Soda machine only; other vendings are cosmetic.
  if (!/vending1/i.test(machine.kind)) {
    sendError(dispatcher, m.sender, 'out_of_stock', 'this machine is empty');
    return;
  }
  // Find a yen stack with at least 100.
  const yen = player.inventory.items.find(
    (it) => it.itemId === 'yen' && it.count >= VENDING_COST_YEN,
  );
  if (!yen) {
    sendError(dispatcher, m.sender, 'no_yen', `you need ${VENDING_COST_YEN} yen`);
    return;
  }
  // Deduct yen (whole-array replacement for Goja proxy correctness).
  const updatedYen = { ...yen, count: yen.count - VENDING_COST_YEN };
  let inv: typeof player.inventory = {
    ...player.inventory,
    items: player.inventory.items.map((it) => (it.instanceId === yen.instanceId ? updatedYen : it)),
  };
  // Remove the stack entirely if it hit zero.
  if (updatedYen.count <= 0) {
    inv = {
      ...inv,
      items: inv.items.filter((it) => it.instanceId !== yen.instanceId),
      hotkeys: inv.hotkeys.map((slot) =>
        slot === yen.instanceId ? null : slot,
      ) as typeof inv.hotkeys,
      equipped: inv.equipped === yen.instanceId ? null : inv.equipped,
    };
  }
  player.inventory = inv;
  // Grant the soda.
  const r = addItem(player.inventory, 'soda', 1);
  if (r) player.inventory = r.inventory;
  sendInvFull(dispatcher, state, m.sender);
  broadcastFxSound(dispatcher, 'page_turn_1', req.x, req.y, 0.5);
}

function handleDoorToggle(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  const req = parseBody<C2SDoorToggle>(m.data);
  if (!req) return;
  if (Math.max(Math.abs(req.x - player.x), Math.abs(req.y - player.y)) > 1) {
    sendError(dispatcher, m.sender, 'too_far', 'door not adjacent');
    return;
  }
  if (!tilemap.isDoor(req.x, req.y)) return;
  state.openDoors ??= {};
  const key = `${req.x},${req.y}`;
  const isOpen = state.openDoors[key] === true;
  state.openDoors[key] = !isOpen;
  const payload: S2CDoorState = { x: req.x, y: req.y, open: !isOpen };
  dispatcher.broadcastMessage(OpCode.S2C_DOOR_STATE, JSON.stringify(payload), null, null, true);
  broadcastFxSound(dispatcher, 'doormetal', req.x, req.y, 0.6);
}

function findAdjacentDoor(x: number, y: number): { x: number; y: number } | null {
  for (const d of tilemap.raw.doors) {
    if (Math.max(Math.abs(d.x - x), Math.abs(d.y - y)) <= 1) return d;
  }
  return null;
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
  broadcastPlayerMoved(dispatcher, attacker, tick, state);

  if (!result.hitUserId) return;
  const victim = state.players[result.hitUserId];
  if (!victim) return;

  broadcastPlayerHealth(dispatcher, victim);
  // Self-only HP detail to the victim's HUD.
  const victimPresence = state.presences[victim.userId];
  if (victimPresence) sendPlayerHP(dispatcher, victimPresence, victim);

  // Mode-script onAttack hook (vampire heal-on-hit, zombie infection).
  const modeDef = getMode(effectiveModeId(state));
  const modeScript = modeDef?.scriptId ? MODE_SCRIPTS[modeDef.scriptId] : undefined;
  modeScript?.onAttack?.(state, attacker, victim, result.weaponName, {
    tick,
    tickRate: TICK_RATE,
  });
  // Reflect any HP change the script just made.
  if (modeScript?.onAttack) {
    broadcastPlayerHealth(dispatcher, attacker);
    const ap = state.presences[attacker.userId];
    if (ap) sendPlayerHP(dispatcher, ap, attacker);
    // Drain any fx the script queued (witch butterfly, etc.).
    if (state.scheduledButterfly && state.scheduledButterfly.length > 0) {
      for (const f of state.scheduledButterfly) {
        const payload: S2CFxButterfly = { x: f.x, y: f.y, durationMs: 1500 };
        dispatcher.broadcastMessage(
          OpCode.S2C_FX_BUTTERFLY,
          JSON.stringify(payload),
          null,
          null,
          true,
        );
      }
      state.scheduledButterfly = [];
    }
  }

  if (result.killed && result.corpse) {
    state.corpses[result.corpse.corpseId] = result.corpse;
    broadcastPlayerDied(dispatcher, victim, attacker.userId, result.weaponName);
    broadcastCorpseUpdate(dispatcher, result.corpse);
    broadcastFxSound(dispatcher, sfxForWeapon(result.weaponName), victim.x, victim.y, 0.9);
    broadcastFxSound(dispatcher, 'body_fall', victim.x, victim.y, 0.7);
    // Mode-script onDeath hook (witch revive).
    modeScript?.onDeath?.(state, victim, attacker.userId, { tick, tickRate: TICK_RATE });
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
  // Consent gate: if the killer is alive in the match, ask them first.
  // No killer or killer dead → auto-grant. Killer is the searcher → auto.
  const killerId = c.killerUserId;
  const killer = killerId ? state.players[killerId] : null;
  if (killer && killer.isAlive && killer.userId !== player.userId) {
    const requestId = newCorpseId(); // reuse the random-id helper
    state.searchRequests ??= {};
    state.searchRequests[requestId] = {
      searcherUserId: player.userId,
      corpseId: c.corpseId,
      askedAtTick: state.tickN,
    };
    const killerPresence = state.presences[killer.userId];
    if (killerPresence) {
      const payload: S2CSearchRequest = {
        requestId,
        searcherUserId: player.userId,
        searcherUsername: player.username,
        corpseId: c.corpseId,
      };
      dispatcher.broadcastMessage(
        OpCode.S2C_SEARCH_REQUEST,
        JSON.stringify(payload),
        [killerPresence],
        null,
        true,
      );
    }
    return;
  }
  // No consent gate → reply immediately.
  sendCorpseContents(dispatcher, m.sender, c);
}

function handleSearchConsent(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const responder = state.players[m.sender.userId];
  if (!responder) return;
  const req = parseBody<C2SSearchConsent>(m.data);
  if (!req) return;
  const pending = state.searchRequests?.[req.requestId];
  if (!pending) return;
  const corpse = state.corpses[pending.corpseId];
  // Only the corpse's killer can answer.
  if (!corpse || corpse.killerUserId !== responder.userId) return;
  delete state.searchRequests?.[req.requestId];

  const searcherPresence = state.presences[pending.searcherUserId];
  if (!searcherPresence) return;
  if (req.accept) {
    sendCorpseContents(dispatcher, searcherPresence, corpse);
  } else {
    const payload: S2CSearchDenied = {
      corpseId: corpse.corpseId,
      reason: `${responder.username} declined your search`,
    };
    dispatcher.broadcastMessage(
      OpCode.S2C_SEARCH_DENIED,
      JSON.stringify(payload),
      [searcherPresence],
      null,
      true,
    );
  }
}

function sendCorpseContents(
  dispatcher: nkruntime.MatchDispatcher,
  recipient: nkruntime.Presence,
  c: Corpse,
): void {
  const payload: S2CCorpseContents = { corpseId: c.corpseId, contents: c.contents };
  dispatcher.broadcastMessage(
    OpCode.S2C_CORPSE_CONTENTS,
    JSON.stringify(payload),
    [recipient],
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

/** Map a role id → the named spawn it should occupy, when one applies. */
const SPECIAL_SPAWN_BY_ROLE: Record<string, string> = {
  watcher: 'Watcher',
  shinigami: 'ShiniSpawn',
  escaped: 'EscapedSpawn',
};

/** Move role-restricted players to their named spawn points after assignment. */
/** Drain Death Note kill / Witch revive / Zombie infection schedulers. */
function drainScheduledEffects(
  state: PyrceMatchState,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  logger: nkruntime.Logger,
): void {
  // Death Note: kill victims whose heart-attack timer has elapsed.
  if (state.scheduledDeaths && state.scheduledDeaths.length > 0) {
    const remaining: typeof state.scheduledDeaths = [];
    for (const s of state.scheduledDeaths) {
      if (tick < s.atTick) {
        remaining.push(s);
        continue;
      }
      const victim = state.players[s.victimUserId];
      if (!victim || !victim.isAlive) continue;
      victim.hp = 0;
      victim.isAlive = false;
      victim.isWatching = true;
      const corpse: Corpse = {
        corpseId: newCorpseId(),
        victimUserId: victim.userId,
        victimUsername: victim.username,
        victimRealName: victim.realName,
        killerUserId: s.killerUserId,
        cause: s.cause,
        x: victim.x,
        y: victim.y,
        contents: victim.inventory.items.slice(),
        discovered: false,
        discoveredByUserId: null,
      };
      victim.inventory = {
        items: [],
        hotkeys: [null, null, null, null, null],
        equipped: null,
        weight: 0,
        weightCap: victim.inventory.weightCap,
      };
      state.corpses[corpse.corpseId] = corpse;
      broadcastPlayerDied(dispatcher, victim, s.killerUserId, s.cause);
      broadcastCorpseUpdate(dispatcher, corpse);
      broadcastFxSound(dispatcher, 'body_fall', victim.x, victim.y, 0.7);
      logger.info('death-note kill: %s by %s', victim.userId, s.killerUserId);
    }
    state.scheduledDeaths = remaining;
  }

  // Witch: revive players whose timer has elapsed.
  if (state.scheduledRevives && state.scheduledRevives.length > 0) {
    const remaining: typeof state.scheduledRevives = [];
    for (const s of state.scheduledRevives) {
      if (tick < s.atTick) {
        remaining.push(s);
        continue;
      }
      const target = state.players[s.userId];
      if (!target) continue;
      const spawn = pickRandomSpawn();
      target.hp = target.maxHp;
      target.isAlive = true;
      target.isWatching = false;
      target.x = spawn.x;
      target.y = spawn.y;
      broadcastPlayerHealth(dispatcher, target);
      broadcastPlayerMoved(dispatcher, target, tick, state);
      broadcastAnnouncement(dispatcher, {
        kind: 'mode_event',
        message: `${target.username} stirs back to life…`,
      });
      const targetPresence = state.presences[target.userId];
      if (targetPresence) sendSelfRoleState(dispatcher, targetPresence, target);
      logger.info('witch revive: %s', target.userId);
    }
    state.scheduledRevives = remaining;
  }

  // Zombie: turn infected players who've passed the timer.
  if (state.scheduledInfections && state.scheduledInfections.length > 0) {
    const remaining: typeof state.scheduledInfections = [];
    for (const s of state.scheduledInfections) {
      if (tick < s.atTick) {
        remaining.push(s);
        continue;
      }
      const target = state.players[s.userId];
      if (!target || !target.isAlive) continue;
      target.roleId = 'zombie';
      broadcastAnnouncement(dispatcher, {
        kind: 'mode_event',
        message: `${target.username} has turned!`,
      });
      logger.info('zombie infect: %s turned', target.userId);
    }
    state.scheduledInfections = remaining;
  }
}

/**
 * Force-kill players who've been disconnected longer than the reconnect
 * grace window. Drops a corpse like any other death so the round can
 * resolve via win conditions.
 */
function reapStaleDisconnects(
  state: PyrceMatchState,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  logger: nkruntime.Logger,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  for (const userId in state.players) {
    const p = state.players[userId];
    if (!p || !p.isAlive) continue;
    const at = p.disconnectedAtTick;
    if (at === undefined) continue;
    if (tick - at < RECONNECT_GRACE_TICKS) continue;
    p.hp = 0;
    p.isAlive = false;
    p.isWatching = true;
    delete p.disconnectedAtTick;
    const corpse: Corpse = {
      corpseId: newCorpseId(),
      victimUserId: p.userId,
      victimUsername: p.username,
      victimRealName: p.realName,
      killerUserId: null,
      cause: 'Disconnect',
      x: p.x,
      y: p.y,
      contents: p.inventory.items.slice(),
      discovered: false,
      discoveredByUserId: null,
    };
    p.inventory = {
      items: [],
      hotkeys: [null, null, null, null, null],
      equipped: null,
      weight: 0,
      weightCap: p.inventory.weightCap,
    };
    state.corpses[corpse.corpseId] = corpse;
    broadcastPlayerDied(dispatcher, p, null, 'Disconnect');
    broadcastCorpseUpdate(dispatcher, corpse);
    broadcastAnnouncement(dispatcher, {
      kind: 'system',
      message: `${p.username} disconnected and was lost to the round.`,
    });
    logger.info('disconnect kill: %s after %d ticks', p.userId, tick - at);
  }
}

function newCorpseId(): string {
  return `corpse-${Math.random().toString(36).slice(2, 12)}`;
}

function pickRandomSpawn(): { x: number; y: number } {
  const list = tilemap.playerSpawns;
  return list[Math.floor(Math.random() * list.length)] ?? { x: 36, y: 66 };
}

function relocateSpecialSpawns(state: PyrceMatchState): void {
  for (const userId in state.players) {
    const p = state.players[userId];
    if (!p) continue;
    const target = SPECIAL_SPAWN_BY_ROLE[p.roleId];
    if (!target) continue;
    const spot = tilemap.spawnsById.get(target);
    if (!spot) continue;
    p.x = spot.x;
    p.y = spot.y;
  }
}

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
  state?: PyrceMatchState,
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
  // Ghost-mode invisibility: when the moved player is a ghost, only the
  // ghost themselves, Whisperers, and the dead see the broadcast (per DM
  // mob.invisibility=2 + Ghost_Whisperer can-see).
  const recipients = state && player.roleId === 'ghost' ? recipientsCanSee(state, player) : null;
  dispatcher.broadcastMessage(
    OpCode.S2C_PLAYER_MOVED,
    JSON.stringify(payload),
    recipients,
    null,
    true,
  );
}

/** Presences whose owning player is allowed to see `target`. */
function recipientsCanSee(state: PyrceMatchState, target: PlayerInGame): nkruntime.Presence[] {
  const out: nkruntime.Presence[] = [];
  for (const userId in state.presences) {
    const viewer = state.players[userId];
    const presence = state.presences[userId];
    if (!presence) continue;
    if (canSee(viewer ?? null, target)) out.push(presence);
  }
  return out;
}

/** True if `viewer` can perceive `target`. Ghost is hidden from civilians. */
function canSee(viewer: PlayerInGame | null, target: PlayerInGame): boolean {
  if (target.roleId !== 'ghost') return true;
  if (!viewer) return true; // unaffiliated presence (spectator) — show
  if (viewer.userId === target.userId) return true;
  if (!viewer.isAlive || viewer.isWatching) return true; // dead can see all
  return viewer.roleId === 'ghost' || viewer.roleId === 'whisperer';
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

function broadcastFxSound(
  dispatcher: nkruntime.MatchDispatcher,
  key: string,
  x: number,
  y: number,
  volume = 1.0,
): void {
  const payload: S2CFxSound = { key, x, y, volume };
  dispatcher.broadcastMessage(OpCode.S2C_FX_SOUND, JSON.stringify(payload), null, null, true);
}

/** Map a weapon name to the SFX key. Falls through to "punch" for unarmed. */
function sfxForWeapon(weaponName: string): string {
  const n = weaponName.toLowerCase();
  if (n.includes('knife')) return 'knife_stab';
  if (n.includes('axe')) return 'axe_door';
  if (n.includes('billhook')) return 'billhook';
  if (n.includes('taser')) return 'taser';
  if (n.includes('bat') || n.includes('pipe') || n.includes('hammer')) return 'bat_hit';
  return 'punch';
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
  // Also send the self-role-state once so the HUD can render counters.
  sendSelfRoleState(dispatcher, recipient, player);
}

function sendSelfRoleState(
  dispatcher: nkruntime.MatchDispatcher,
  recipient: nkruntime.Presence,
  player: PlayerInGame,
): void {
  const payload: S2CSelfRoleState = {};
  if (player.roleId === 'witch') {
    const used = (player.roleData?.['revives'] as number | undefined) ?? 0;
    payload.witchRevivesLeft = Math.max(0, 5 - used);
  } else if (player.roleId === 'vampire') {
    payload.vampireDrained = (player.roleData?.['drained'] as number | undefined) ?? 0;
  } else {
    return; // no relevant counters for this role
  }
  dispatcher.broadcastMessage(
    OpCode.S2C_SELF_ROLE_STATE,
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
  const viewer = state.players[recipient.userId];
  const players = Object.values(state.players)
    .filter((p) => canSee(viewer ?? null, p))
    .map(toPublicPlayerInGame);
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
