import {
  type C2SAcceptEyes,
  type C2SAttack,
  type C2SCameraView,
  type C2SChat,
  type C2SContainerLook,
  type C2SContainerPush,
  type C2SContainerPut,
  type C2SContainerTake,
  type C2SCorpsePush,
  type C2SDoorCodeEntry,
  type C2SDoorToggle,
  type C2SDoppelgangerCopy,
  type C2SDragCorpse,
  type C2SInjectTarget,
  type C2SInvCraft,
  type C2SInvDrop,
  type C2SInvEquip,
  type C2SInvPickup,
  type C2SInvSetHotkey,
  type C2SInvUse,
  type C2SLightSwitchToggle,
  type C2SLobbyStartGame,
  type C2SMoveIntent,
  type C2SOfferEyes,
  type C2SPaperAirplane,
  type C2SPaperWrite,
  type C2SPdaSend,
  type C2SPlantItem,
  type C2SPullToggle,
  type C2SRoleAbility,
  type C2SSearchConsent,
  type C2SSearchCorpse,
  type C2SSprintToggle,
  type C2STakeFromCorpse,
  type C2STypingBegin,
  type C2STypingEnd,
  type C2SVampireDrain,
  type C2SVendingBuy,
  type C2SViewProfile,
  type C2SVoteEndGame,
  type C2SVoteKick,
  type C2SVoteMode,
  ChatChannel,
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
  type S2CBloodDrip,
  type S2CCameraFeed,
  type S2CChatMessage,
  type S2CClockTick,
  type S2CContainerContents,
  type S2CContainerMoved,
  type S2CCorpseContents,
  type S2CCorpseDespawn,
  type S2CCorpseSpawn,
  type S2CCraftResult,
  type S2CDoorCode,
  type S2CDoorState,
  type S2CEyeOffer,
  type S2CFxButterfly,
  type S2CFxFeather,
  type S2CFxSmoke,
  type S2CFxSound,
  type S2CFxSwing,
  type S2CGameResult,
  type S2CGhostSense,
  type S2CInitialSnapshot,
  type S2CInvDelta,
  type S2CInvFull,
  type S2CLightState,
  type S2CPaperReceived,
  type S2CPaperText,
  type S2CPhaseChange,
  type S2CPlayerDied,
  type S2CPlayerHealth,
  type S2CPlayerHP,
  type S2CPlayerMoved,
  type S2CPlayerStamina,
  type S2CPlayerStatus,
  type S2CProfileView,
  type S2CRoleAssigned,
  type S2CSearchDenied,
  type S2CSearchRequest,
  type S2CSelfRoleState,
  type S2CStudentRoster,
  type S2CTapeResult,
  type S2CTyping,
  type S2CVoteEndGameTally,
  type S2CVoteKickTally,
  type S2CVoteModeTally,
  type S2CWorldGroundItemDelta,
  type S2CWorldGroundItems,
  rollDemographics,
  rollUniqueDemographics,
  type S2CLobbyState,
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
  BLEEDING_WEAPONS,
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
  updatePlayer,
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
    lobbyDemographics: {},
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
    // Allow late joiners through to become Watchers via the C2S opcode.
    return { state, accept: true };
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
    // First time we see this user this match: roll their demographics so
    // the lobby UI can already show "Male with brown hair".
    if (!state.lobbyDemographics[p.userId]) {
      state.lobbyDemographics[p.userId] = rollUniqueDemographics(
        Object.values(state.lobbyDemographics),
      );
    }
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
  broadcastLobbyState(dispatcher, state);
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
      delete state.lobbyDemographics[p.userId];
    } else if (state.phase === MatchPhase.InGame) {
      // Stamp the disconnect tick. matchLoop kills the player if they're
      // still gone after RECONNECT_GRACE_TICKS so the round can resolve.
      const player = state.players[p.userId];
      if (player && player.isAlive) player.disconnectedAtTick = tick;
    }
    logger.info('match leave (phase=%s): user=%s', state.phase, p.userId);
  }
  refreshLabel(dispatcher, state);
  broadcastLobbyState(dispatcher, state);
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

  // Auto-return everyone to the lobby a few seconds after the round ends.
  if (
    state.phase === MatchPhase.Ending &&
    state.endingResetAtTick !== undefined &&
    tick >= state.endingResetAtTick
  ) {
    resetToLobby(state, dispatcher, logger);
  }

  // Mode-script per-tick scheduler drain (death-note kills, witch revives,
  // zombie infections turning).
  drainScheduledEffects(state, dispatcher, tick, logger);

  // Reap players whose presence has been gone too long.
  reapStaleDisconnects(state, dispatcher, tick, logger);

  // Whisperer ghost-sense: periodic directional clue. Cheap; only fires
  // every 20 ticks (~2s) to avoid spamming.
  if (tick % 20 === 0) broadcastGhostSenseToWhisperers(state, dispatcher);

  // Vampire hunger: every ~8s drain 1 HP from every alive vampire so they
  // have to keep feeding to survive. Floors at 1 HP — hunger alone won't
  // finish them, but it forces them to act.
  if (tick % 80 === 0) {
    for (const uid in state.players) {
      const p = state.players[uid];
      if (!p || !p.isAlive || p.roleId !== 'vampire' || p.hp <= 1) continue;
      p.hp -= 1;
      broadcastPlayerHealth(dispatcher, p);
      const pres = state.presences[uid];
      if (pres) sendPlayerHP(dispatcher, pres, p);
      if (p.hp <= 20 && p.hp > 18) {
        broadcastAnnouncement(dispatcher, {
          kind: 'mode_event',
          message: `${p.displayName} looks pale and weak.`,
        });
      }
    }
  }

  // Sprint drain: every SPRINT_DRAIN_INTERVAL_TICKS, drain 1 stamina from
  // each sprinting player. Auto-disable when stamina runs out.
  if (state.sprinting && tick % SPRINT_DRAIN_INTERVAL_TICKS === 0) {
    for (const uid in state.sprinting) {
      const p = state.players[uid];
      if (!p || !p.isAlive) {
        delete state.sprinting[uid];
        if (state.lastSprintDrainTick) delete state.lastSprintDrainTick[uid];
        continue;
      }
      p.stamina = Math.max(0, p.stamina - 1);
      const pres = state.presences[uid];
      if (pres) sendStamina(dispatcher, pres, p);
      if (p.stamina < SPRINT_MIN_STAMINA) {
        delete state.sprinting[uid];
        if (state.lastSprintDrainTick) delete state.lastSprintDrainTick[uid];
      }
    }
  }

  // Eye-deal offer expiry: drop pending offers whose timeout has elapsed.
  if (state.eyeOffers) {
    for (const uid in state.eyeOffers) {
      const o = state.eyeOffers[uid];
      if (o && tick >= o.expiresAtTick) delete state.eyeOffers[uid];
    }
  }

  // Slow expiry: drop slowedUntilTick entries whose timers have elapsed,
  // refreshing the player's status HUD when one ends.
  if (state.slowedUntilTick) {
    for (const uid in state.slowedUntilTick) {
      const until = state.slowedUntilTick[uid] ?? 0;
      if (tick >= until) {
        const p = state.players[uid];
        delete state.slowedUntilTick[uid];
        if (p) pushStatus(state, dispatcher, p);
      }
    }
  }

  // Bleed tick: every 10 ticks (1s) deal 2 HP to anyone with an active
  // bleed timer; expire when the timer's reached.
  if (state.bleedUntilTick && tick % 10 === 0) {
    for (const uid in state.bleedUntilTick) {
      const until = state.bleedUntilTick[uid] ?? 0;
      const p = state.players[uid];
      if (!p || !p.isAlive) {
        delete state.bleedUntilTick[uid];
        continue;
      }
      if (tick >= until) {
        delete state.bleedUntilTick[uid];
        pushStatus(state, dispatcher, p);
        continue;
      }
      p.hp = Math.max(0, p.hp - 2);
      broadcastPlayerHealth(dispatcher, p);
      const pres = state.presences[uid];
      if (pres) sendPlayerHP(dispatcher, pres, p);
      // Bleeding can kill — convert to a corpse if HP hits 0.
      if (p.hp === 0) {
        p.isAlive = false;
        p.isWatching = true;
        const corpse: Corpse = {
          corpseId: newCorpseId(),
          victimUserId: p.userId,
          victimDisplayName: p.displayName,
          victimHairId: p.hairId,
          victimRealName: p.realName,
          killerUserId: null,
          cause: 'Bled out',
          x: p.x,
          y: p.y,
          contents: p.inventory.items.slice(),
          discovered: false,
          discoveredByUserId: null,
        };
        updatePlayer(state, p.userId, { inventory: {
          items: [],
          hotkeys: [null, null, null, null, null],
          equipped: null,
          weight: 0,
          weightCap: p.inventory.weightCap,
        } });
        state.corpses[corpse.corpseId] = corpse;
        broadcastPlayerDied(dispatcher, p, null, 'Bled out');
        broadcastCorpseUpdate(dispatcher, corpse);
        delete state.bleedUntilTick[uid];
      }
    }
  }

  // Drop expired witch invisibility.
  for (const uid in state.players) {
    const p = state.players[uid];
    const until = p?.roleData?.['invisableUntilTick'] as number | undefined;
    if (p && until !== undefined && tick >= until) {
      const next = { ...(p.roleData ?? {}) };
      delete next['invisableUntilTick'];
      p.roleData = next;
      broadcastPlayerMoved(dispatcher, p, tick, state);
    }
  }

  // Pull-corpse: any player dragging a corpse drags it to their old
  // tile after they move (corpses follow on every move broadcast we've
  // already fired — but cheap to reconcile here too).
  if (state.pullingCorpse) {
    for (const userId in state.pullingCorpse) {
      const corpseId = state.pullingCorpse[userId];
      if (!corpseId) continue;
      const corpse = state.corpses[corpseId];
      const dragger = state.players[userId];
      if (!corpse || !dragger || !dragger.isAlive) {
        delete state.pullingCorpse[userId];
        continue;
      }
      const dist = Math.max(Math.abs(corpse.x - dragger.x), Math.abs(corpse.y - dragger.y));
      if (dist > 1) {
        // Snap corpse to within 1 tile (place behind the dragger's facing).
        const moved = { ...corpse, x: dragger.x, y: dragger.y };
        state.corpses[corpse.corpseId] = moved;
        broadcastCorpseUpdate(dispatcher, moved);
      }
    }
  }

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
      message: bodyDiscoveryMessage(state, c),
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
        // Auto-return everyone to the lobby after a brief reveal screen.
        state.endingResetAtTick = tick + TICK_RATE * 10;
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
    case OpCode.C2S_DOOR_CODE_ENTRY:
      handleDoorCodeEntry(state, m, dispatcher);
      break;
    case OpCode.C2S_JOIN_AS_WATCHER:
      handleJoinAsWatcher(state, m, dispatcher);
      break;
    case OpCode.C2S_THROW:
      handleThrow(state, m, tick, dispatcher);
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
    case OpCode.C2S_ROLE_ABILITY:
      handleRoleAbility(state, m, tick, dispatcher);
      break;
    case OpCode.C2S_PULL_TOGGLE:
      handlePullToggle(state, m, dispatcher);
      break;
    case OpCode.C2S_PAPER_WRITE:
      handlePaperWrite(state, m, dispatcher);
      break;
    case OpCode.C2S_PAPER_AIRPLANE:
      handlePaperAirplane(state, m, dispatcher);
      break;
    case OpCode.C2S_SUICIDE:
      handleSuicide(state, m, dispatcher, logger);
      break;
    case OpCode.C2S_ESCAPE_DOOR:
      handleEscapeDoor(state, m, dispatcher);
      break;
    case OpCode.C2S_WASH:
      handleWash(state, m, tick, dispatcher);
      break;
    case OpCode.C2S_SPRINT_TOGGLE:
      handleSprintToggle(state, m, dispatcher);
      break;
    case OpCode.C2S_PLANT_ITEM:
      handlePlantItem(state, m, dispatcher);
      break;
    case OpCode.C2S_INJECT_TARGET:
      handleInjectTarget(state, m, dispatcher);
      break;
    case OpCode.C2S_SHOVE:
      handleShove(state, m, tick, dispatcher);
      break;
    case OpCode.C2S_PDA_SEND:
      handlePdaSend(state, m, dispatcher);
      break;
    case OpCode.C2S_CONTAINER_PUSH:
      handleContainerPush(state, m, dispatcher);
      break;
    case OpCode.C2S_CORPSE_PUSH:
      handleCorpsePush(state, m, dispatcher);
      break;
    case OpCode.C2S_LIGHT_SWITCH_TOGGLE:
      handleLightSwitchToggle(state, m, dispatcher);
      break;
    case OpCode.C2S_CAMERA_VIEW:
      handleCameraView(state, m, dispatcher);
      break;
    case OpCode.C2S_TAPE_VIEW:
      handleTapeView(state, m, dispatcher);
      break;
    case OpCode.C2S_TAPE_DELETE:
      handleTapeDelete(state, m, dispatcher);
      break;
    case OpCode.C2S_OFFER_EYES:
      handleOfferEyes(state, m, dispatcher);
      break;
    case OpCode.C2S_ACCEPT_EYES:
      handleAcceptEyes(state, m, dispatcher);
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
  // Random 3-digit code used by door_code_paper / door_code_view.
  state.doorCode = `${Math.floor(100 + Math.random() * 900)}`;
  // Lock ~5 random doors so the door code matters.
  state.lockedDoors = {};
  const allDoors = tilemap.raw.doors;
  const pool = allDoors.slice();
  for (let i = 0; i < Math.min(5, pool.length); i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const d = pool.splice(idx, 1)[0];
    if (d) state.lockedDoors[`${d.x},${d.y}`] = true;
  }
  assignSpawns(state);
  state.containers = seedContainers();
  state.groundItems = {};
  state.corpses = {};
  state.ended = false;
  // Mode engine: assign roles + grant starting items.
  assignRoles(state, modeDef);
  applyItemGrants(state, modeDef, logger);
  relocateSpecialSpawns(state);
  seedDetectiveClue(state);
  state.clock = newClock(state.tickN);
  broadcastPhaseChange(dispatcher, state);
  // Secret mode shows the secret announcement; everyone else shows the
  // unwrapped mode's flavor.
  broadcastAnnouncement(dispatcher, {
    kind: 'mode_event',
    message: openingFlavorFor(state.gameModeId ?? ''),
  });
  for (const userId in state.presences) {
    const p = state.presences[userId];
    const player = state.players[userId];
    if (p && player) {
      sendInvFull(dispatcher, state, p);
      sendRoleAssigned(dispatcher, p, player);
    }
  }
  sendGroundItemsFull(dispatcher, state, null);
  broadcastLightState(dispatcher, state);
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
  const isSprinting = !!state.sprinting?.[m.sender.userId] && player.stamina >= SPRINT_MIN_STAMINA;
  const isSlowed = (state.slowedUntilTick?.[m.sender.userId] ?? 0) > tick;
  let cooldown = MOVE_COOLDOWN_TICKS;
  if (isSprinting) cooldown = Math.max(1, Math.floor(cooldown / 2));
  if (isSlowed) cooldown = cooldown * 2;
  if (tick - player.lastMoveTickN < cooldown) return;
  if ((state.koUntilTick?.[m.sender.userId] ?? 0) > tick) return;
  if ((state.frozenUntilTick?.[m.sender.userId] ?? 0) > tick) return;

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
  // Physical map objects (containers, corpses, closed doors) block tile-step
  // movement. Vendings are static and already baked into tilemap.isPassable.
  if (
    entryAt(state.containers, nx, ny) ||
    entryAt(state.corpses, nx, ny) ||
    closedDoorAt(state, nx, ny)
  ) {
    broadcastPlayerMoved(dispatcher, player, tick, state);
    return;
  }
  for (const otherId in state.players) {
    if (otherId === player.userId) continue;
    const o = state.players[otherId];
    if (o && o.x === nx && o.y === ny) return;
  }
  const prevX = player.x;
  const prevY = player.y;
  player.x = nx;
  player.y = ny;
  player.lastMoveTickN = tick;

  // Bloody players leave a drip trail at the tile they just left.
  if ((player.bloody ?? 0) > 0) {
    const drip: S2CBloodDrip = { x: prevX, y: prevY, intensity: player.bloody ?? 1 };
    dispatcher.broadcastMessage(OpCode.S2C_BLOOD_DRIP, JSON.stringify(drip), null, null, true);
  }

  // Step on a popper trap → KO + broadcast the explosion.
  triggerPopperIfAny(state, dispatcher, player, tick);

  broadcastPlayerMoved(dispatcher, player, tick, state);

  // Warp tile: if the destination tile is a warp, teleport to its pair.
  const warp = tilemap.warpAt(nx, ny);
  if (warp) {
    const dest = tilemap.warpDestination(warp.tag, nx, ny);
    if (dest) {
      player.x = dest.x;
      player.y = dest.y;
      broadcastPlayerMoved(dispatcher, player, tick, state);
      broadcastFxSound(dispatcher, 'doormetal', dest.x, dest.y, 0.4);
      return;
    }
  }

  // Footstep audio at low volume; range-attenuated by the client.
  // Witch invisablewalk: silent steps so the disguise isn't blown by sound.
  const invUntil = player.roleData?.['invisableUntilTick'] as number | undefined;
  if (invUntil === undefined || tick >= invUntil) {
    broadcastFxSound(dispatcher, 'footsteps', nx, ny, 0.25);
  }
}

/**
 * Popper traps are ground items; stepping on one triggers an explosion
 * and KOs anyone within Chebyshev 1. The trigger consumes the popper.
 */
function triggerPopperIfAny(
  state: PyrceMatchState,
  dispatcher: nkruntime.MatchDispatcher,
  player: PlayerInGame,
  tick: number,
): void {
  let popperId: string | null = null;
  for (const gid in state.groundItems) {
    const g = state.groundItems[gid];
    if (g && g.itemId === 'poppers' && g.x === player.x && g.y === player.y) {
      popperId = gid;
      break;
    }
  }
  if (!popperId) return;
  delete state.groundItems[popperId];
  broadcastGroundItemDelta(dispatcher, { removed: [popperId] });
  const fx: S2CFxSmoke = { x: player.x, y: player.y, durationMs: 1500 };
  dispatcher.broadcastMessage(OpCode.S2C_FX_SMOKE, JSON.stringify(fx), null, null, true);
  broadcastFxSound(dispatcher, 'smallexplosion', player.x, player.y, 0.7);
  state.koUntilTick ??= {};
  state.koUntilTick[player.userId] = tick + TICK_RATE * 4;
  pushStatus(state, dispatcher, player);
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
  updatePlayer(state, m.sender.userId, { inventory: r.inventory });
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
  updatePlayer(state, m.sender.userId, { inventory: r.inventory });
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
  updatePlayer(state, m.sender.userId, { inventory: e });
  const updated = state.players[m.sender.userId];
  if (!updated) return;
  sendInvDelta(dispatcher, state, m.sender, { equipped: e.equipped });
  broadcastPlayerMoved(dispatcher, updated, state.tickN, state);
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
  updatePlayer(state, m.sender.userId, { inventory: h });
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
      // Drop the popper as a ground item at the player's tile. Anyone
      // (including the placer themselves) who steps on it triggers the
      // explosion + 4s KO via triggerPopperIfAny() in the move handler.
      const ground = fromInstance(inst, player.x, player.y);
      state.groundItems[ground.groundItemId] = ground;
      broadcastGroundItemDelta(dispatcher, { upserted: [toPublicGroundItem(ground)] });
      const removed = removeItem(player.inventory, inst.instanceId);
      if (removed) {
        updatePlayer(state, player.userId, { inventory: removed.inventory });
        sendInvDelta(dispatcher, state, m.sender, {
          removed: [inst.instanceId],
          hotkeys: removed.inventory.hotkeys,
          equipped: removed.inventory.equipped,
          weight: removed.inventory.weight,
        });
      }
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
      updatePlayer(state, player.userId, { inventory: {
        ...player.inventory,
        items: player.inventory.items.map((it) =>
          it.instanceId === inst.instanceId ? updated : it,
        ),
      } });
      sendInvDelta(dispatcher, state, m.sender, { upserted: [updated] });
      return;
    }
    case 'syringe': {
      const filled = inst.data?.['filled'];
      if (!filled) {
        sendError(dispatcher, m.sender, 'empty_syringe', 'fill the syringe first');
        return;
      }
      if (filled === 'Regenerative') {
        player.hp = Math.min(player.maxHp, player.hp + 30);
        sendPlayerHP(dispatcher, m.sender, player);
      } else if (filled === 'Cure') {
        // Reverses an active zombie infection. Drops the player's pending
        // turn timer if one's queued.
        const before = state.scheduledInfections?.length ?? 0;
        if (state.scheduledInfections) {
          state.scheduledInfections = state.scheduledInfections.filter(
            (s) => s.userId !== player.userId,
          );
        }
        if ((state.scheduledInfections?.length ?? 0) < before) {
          broadcastAnnouncement(dispatcher, {
            kind: 'mode_event',
            message: `${player.displayName} cured the infection.`,
          });
        }
      } else if (filled === 'Sedative') {
        // DM: sedative slows movement (move_speed=9) for ~10s — it doesn't KO.
        // Inject-other (C2S_INJECT_TARGET) is the real use case; self-injection
        // is a niche pre-emptive nerf to your own movement.
        state.slowedUntilTick ??= {};
        state.slowedUntilTick[player.userId] = state.tickN + TICK_RATE * 10;
        broadcastAnnouncement(dispatcher, {
          kind: 'mode_event',
          message: `${player.displayName} stumbles, drugged.`,
        });
        pushStatus(state, dispatcher, player);
      }
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
      updatePlayer(state, player.userId, { inventory: {
        ...player.inventory,
        items: player.inventory.items.map((it) =>
          it.instanceId === inst.instanceId ? updated : it,
        ),
      } });
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
      // School Computer (DM `School Computer.dm`): show the student roster,
      // grouped by homeroom so survivors can spot a missing classmate. We
      // include classroom on each entry; the client formats per-classroom.
      const entries: S2CStudentRoster['entries'] = [];
      for (const uid in state.players) {
        const p = state.players[uid];
        if (!p) continue;
        entries.push({
          userId: p.userId,
          displayName: p.displayName,
          isAlive: p.isAlive,
          condition: describeCondition(p),
          ...(p.classroom ? { classroom: p.classroom } : {}),
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
      // Grab + freeze instead of insta-kill (DM Black Feather.dm — the
      // feather pulls the victim to the path's end and holds them frozen
      // for 5 seconds. Allies can attack the feather's victim normally
      // during that window.).
      if (hitVictim) {
        broadcastAnnouncement(dispatcher, {
          kind: 'mode_event',
          message: `${player.displayName} reaches out — a black feather curls through the air.`,
        });
      }
      if (hitVictim && path.length > 0) {
        const last = path[path.length - 1];
        if (last) {
          hitVictim.x = last.x;
          hitVictim.y = last.y;
          broadcastPlayerMoved(dispatcher, hitVictim, state.tickN, state);
        }
        state.frozenUntilTick ??= {};
        state.frozenUntilTick[hitVictim.userId] = state.tickN + TICK_RATE * 5;
        pushStatus(state, dispatcher, hitVictim);
      }
      consumeCharge(state, dispatcher, m.sender, player, inst.instanceId);
      return;
    }
    case 'paper_view': {
      const text = (inst.data?.['text'] as string | undefined) ?? '(blank)';
      const payload: S2CPaperText = { instanceId: inst.instanceId, text };
      dispatcher.broadcastMessage(
        OpCode.S2C_PAPER_TEXT,
        JSON.stringify(payload),
        [m.sender],
        null,
        true,
      );
      sendInvDelta(dispatcher, state, m.sender, {});
      return;
    }
    case 'paper_write': {
      // Tells the client to open a write modal; the client then sends
      // C2S_PAPER_WRITE { instanceId, text } to actually persist text.
      const text = (inst.data?.['text'] as string | undefined) ?? '';
      const payload: S2CPaperText = { instanceId: inst.instanceId, text };
      dispatcher.broadcastMessage(
        OpCode.S2C_PAPER_TEXT,
        JSON.stringify(payload),
        [m.sender],
        null,
        true,
      );
      sendInvDelta(dispatcher, state, m.sender, {});
      return;
    }
    case 'paper_airplane': {
      // The use-handler is the launch step; client sends C2S_PAPER_AIRPLANE
      // with the target pick. Bounce a paper-text echo so the user sees
      // what's currently written.
      const text = (inst.data?.['text'] as string | undefined) ?? '';
      const payload: S2CPaperText = { instanceId: inst.instanceId, text };
      dispatcher.broadcastMessage(
        OpCode.S2C_PAPER_TEXT,
        JSON.stringify(payload),
        [m.sender],
        null,
        true,
      );
      sendInvDelta(dispatcher, state, m.sender, {});
      return;
    }
    case 'pda': {
      // Roster of every alive player + their condition; same payload as the
      // school computer but only revealed on PDA use (DM had a phone book).
      const entries: S2CStudentRoster['entries'] = [];
      for (const uid in state.players) {
        const p = state.players[uid];
        if (!p) continue;
        entries.push({
          userId: p.userId,
          displayName: p.displayName,
          isAlive: p.isAlive,
          condition: describeCondition(p),
          ...(p.classroom ? { classroom: p.classroom } : {}),
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
    case 'door_code_view': {
      const code = state.doorCode ?? '???';
      const payload: S2CDoorCode = { code };
      dispatcher.broadcastMessage(
        OpCode.S2C_DOOR_CODE,
        JSON.stringify(payload),
        [m.sender],
        null,
        true,
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
  updatePlayer(state, player.userId, { inventory: removed.inventory });
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
  // Doppelganger profile spoof: when target is a disguised doppel, return
  // the spoofed stats (Perfect / 100 HP / alive) under the copied corpse's
  // display name. Looking at yourself always shows real stats.
  const disguiseDisplayName = target.roleData?.['disguiseDisplayName'] as string | undefined;
  const disguiseHp = target.roleData?.['disguiseProfileHp'] as number | undefined;
  const disguiseMaxHp = target.roleData?.['disguiseProfileMaxHp'] as number | undefined;
  const isSpoofed =
    target.userId !== viewer.userId && target.roleId === 'doppelganger' && !!disguiseDisplayName;
  const payload: S2CProfileView = isSpoofed
    ? {
        userId: target.userId,
        displayName: disguiseDisplayName ?? target.displayName,
        hp: disguiseHp ?? target.maxHp,
        maxHp: disguiseMaxHp ?? target.maxHp,
        isAlive: true,
        condition: 'Perfect',
      }
    : {
        userId: target.userId,
        displayName: target.displayName,
        hp: target.hp,
        maxHp: target.maxHp,
        isAlive: target.isAlive,
        condition: describeCondition(target),
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
  // Authoritative: only push the corpse directly in front of the player —
  // never sideways or behind, even if the client requested it.
  if (corpse.x !== player.x + delta.dx || corpse.y !== player.y + delta.dy) {
    return;
  }
  const nx = corpse.x + delta.dx;
  const ny = corpse.y + delta.dy;
  if (!tilemap.isPassable(nx, ny)) return;
  const moved = { ...corpse, x: nx, y: ny };
  state.corpses[corpse.corpseId] = moved;
  broadcastCorpseUpdate(dispatcher, moved);
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
  // Snapshot a plausible "alive" profile for the victim so that anyone
  // right-clicking the disguised doppel sees them as Perfect / 100 HP /
  // alive — DM Doppelganger.dm Profile_Spoof. The corpse itself only
  // carries the victim's name + role; we synthesise the rest.
  const fakeMaxHp = state.players[corpse.victimUserId]?.maxHp ?? player.maxHp;
  player.roleData = {
    ...(player.roleData ?? {}),
    disguiseAsUserId: corpse.victimUserId,
    disguiseDisplayName: corpse.victimDisplayName,
    disguiseHairId: corpse.victimHairId,
    disguiseProfileHp: fakeMaxHp,
    disguiseProfileMaxHp: fakeMaxHp,
  };
  broadcastPlayerMoved(dispatcher, player, tick, state);
}

// ---------- role abilities + paper + corpse pull + suicide ----------

function handleRoleAbility(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  tick: number,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  const req = parseBody<C2SRoleAbility>(m.data);
  if (!req) return;
  const modeDef = getMode(effectiveModeId(state));
  const script = modeDef?.scriptId ? MODE_SCRIPTS[modeDef.scriptId] : undefined;
  if (!script?.onAbility) {
    sendError(dispatcher, m.sender, 'no_ability', 'no abilities for this role');
    return;
  }
  const ok = script.onAbility(state, player, req.ability, {
    tick,
    tickRate: TICK_RATE,
    isPassable: (x, y) => tilemap.isPassable(x, y),
  });
  if (!ok) {
    sendError(dispatcher, m.sender, 'not_ready', 'ability unavailable');
    return;
  }
  broadcastPlayerMoved(dispatcher, player, tick, state);
  sendStamina(dispatcher, m.sender, player);
  if (req.ability === 'quickdash') {
    broadcastFxSound(dispatcher, 'quickdash', player.x, player.y, 0.7);
  } else if (req.ability === 'invisablewalk') {
    broadcastFxSound(dispatcher, 'nanaya_disappear', player.x, player.y, 0.6);
  }
}

function handlePullToggle(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  const req = parseBody<C2SPullToggle>(m.data);
  if (!req) return;
  state.pullingCorpse ??= {};
  if (req.corpseId === null) {
    delete state.pullingCorpse[m.sender.userId];
    sendInvDelta(dispatcher, state, m.sender, {});
    return;
  }
  const corpse = state.corpses[req.corpseId];
  if (!corpse) return;
  if (Math.max(Math.abs(corpse.x - player.x), Math.abs(corpse.y - player.y)) > 1) {
    sendError(dispatcher, m.sender, 'too_far', 'corpse not adjacent');
    return;
  }
  state.pullingCorpse[m.sender.userId] = corpse.corpseId;
  sendInvDelta(dispatcher, state, m.sender, {});
}

function handlePaperWrite(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  const req = parseBody<C2SPaperWrite>(m.data);
  if (!req) return;
  const inst = findInstance(player.inventory, req.instanceId);
  if (!inst) return;
  const text = (req.text ?? '').slice(0, 500);
  const updated = { ...inst, data: { ...(inst.data ?? {}), text } };
  updatePlayer(state, player.userId, { inventory: {
    ...player.inventory,
    items: player.inventory.items.map((it) => (it.instanceId === inst.instanceId ? updated : it)),
  } });
  sendInvDelta(dispatcher, state, m.sender, { upserted: [updated] });
  broadcastFxSound(dispatcher, 'writing', player.x, player.y, 0.4);
}

function handlePaperAirplane(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const sender = state.players[m.sender.userId];
  if (!sender || !sender.isAlive) return;
  const req = parseBody<C2SPaperAirplane>(m.data);
  if (!req) return;
  const inst = findInstance(sender.inventory, req.instanceId);
  if (!inst) return;
  const target = state.players[req.targetUserId];
  const targetPresence = target ? state.presences[target.userId] : null;
  if (!target || !targetPresence) {
    sendError(dispatcher, m.sender, 'no_target', 'target not in match');
    return;
  }
  const text = (inst.data?.['text'] as string | undefined) ?? '';
  const payload: S2CPaperReceived = { fromDisplayName: sender.displayName, text };
  dispatcher.broadcastMessage(
    OpCode.S2C_PAPER_RECEIVED,
    JSON.stringify(payload),
    [targetPresence],
    null,
    true,
  );
  const removed = removeItem(sender.inventory, inst.instanceId);
  if (removed) {
    updatePlayer(state, sender.userId, { inventory: removed.inventory });
    sendInvFull(dispatcher, state, m.sender);
  }
  broadcastFxSound(dispatcher, 'birdflap', sender.x, sender.y, 0.5);
}

/** /suicide verb: instant self-kill so a trapped player can let the round end. */
function handleSuicide(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
  logger: nkruntime.Logger,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  player.hp = 0;
  player.isAlive = false;
  player.isWatching = true;
  const corpse: Corpse = {
    corpseId: newCorpseId(),
    victimUserId: player.userId,
    victimDisplayName: player.displayName,
    victimHairId: player.hairId,
    victimRealName: player.realName,
    killerUserId: null,
    cause: 'Suicide',
    x: player.x,
    y: player.y,
    contents: player.inventory.items.slice(),
    discovered: false,
    discoveredByUserId: null,
  };
  updatePlayer(state, player.userId, { inventory: {
    items: [],
    hotkeys: [null, null, null, null, null],
    equipped: null,
    weight: 0,
    weightCap: player.inventory.weightCap,
  } });
  state.corpses[corpse.corpseId] = corpse;
  broadcastPlayerDied(dispatcher, player, null, 'Suicide');
  broadcastCorpseUpdate(dispatcher, corpse);
  broadcastFxSound(dispatcher, 'body_fall', player.x, player.y, 0.7);
  broadcastAnnouncement(dispatcher, {
    kind: 'system',
    message: `${player.displayName} took their own life.`,
  });
  logger.info('suicide: %s', player.userId);
}

/**
 * Body-discovery announcement. 25% chance to swap the standard line for a
 * "suspect description" variant (DM GameStarter.dm:677-696) — only fires
 * when a Suspect role is actually alive in the match.
 */
function bodyDiscoveryMessage(state: PyrceMatchState, c: Corpse): string {
  const finder = state.players[c.discoveredByUserId ?? '']?.displayName ?? 'someone';
  const standard = `Warning: dead body located! ${c.victimRealName} found by ${finder}.`;
  let suspect: PlayerInGame | null = null;
  for (const uid in state.players) {
    const p = state.players[uid];
    if (p?.isAlive && p.roleId === 'suspect') {
      suspect = p;
      break;
    }
  }
  if (!suspect) return standard;
  if (Math.random() >= 0.25) return standard;
  const descriptors = [
    'a tall figure with dark hair',
    'someone in a hooded jacket',
    'a slight figure moving quickly',
    'someone with bloodstained hands',
    'a familiar-looking student',
  ];
  const desc = descriptors[Math.floor(Math.random() * descriptors.length)] ?? descriptors[0];
  return `Warning: dead body located! Witnesses recall ${desc} leaving the area.`;
}

// ---------- escape door ----------

/**
 * Civilian escape via the Steel Door. Requires holding a Key Card and
 * adjacency. Consumes the card, teleports the player to the EscapedSpawn,
 * marks them as escaped (counts as a town survivor for win conditions),
 * and broadcasts a global announcement. Killer escaping = killer auto-loss
 * because the lastFactionStanding check now sees an escaped non-killer.
 */
function handleEscapeDoor(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  if (player.hasEscaped) return;
  if (!tilemap.isAdjacentToEscapeDoor(player.x, player.y)) {
    sendError(dispatcher, m.sender, 'no_escape_door', 'no escape door adjacent');
    return;
  }
  const cardInst = player.inventory.items.find(
    (it) => it.itemId === 'key_card' || it.itemId === 'key_card_rare',
  );
  if (!cardInst) {
    sendError(dispatcher, m.sender, 'no_key_card', 'a Security Clearance Card is required');
    return;
  }
  const removed = removeItem(player.inventory, cardInst.instanceId);
  if (removed) updatePlayer(state, player.userId, { inventory: removed.inventory });
  player.hasEscaped = true;
  player.isAlive = false;
  player.isWatching = true;
  const spawn = tilemap.spawnsById.get('EscapedSpawn');
  if (spawn) {
    player.x = spawn.x;
    player.y = spawn.y;
  }
  broadcastPlayerMoved(dispatcher, player, state.tickN, state);
  sendInvFull(dispatcher, state, m.sender);
  broadcastFxSound(dispatcher, 'doormetal', spawn?.x ?? player.x, spawn?.y ?? player.y, 0.7);
  broadcastAnnouncement(dispatcher, {
    kind: 'system',
    message: `${player.displayName} has escaped Pyrce High!`,
  });
}

// ---------- wash ----------

/**
 * Wash blood off self + equipped weapon. Requires standing on a
 * Bathroom_Floor tile (proxy for "next to a sink" — the tilemap converter
 * doesn't capture sink objects so we use the floor type instead). Brief
 * 3s lockout while washing.
 */
function handleWash(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  tick: number,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  if ((state.washingUntilTick?.[player.userId] ?? 0) > tick) return;
  if (!tilemap.isBathroomFloor(player.x, player.y)) {
    sendError(dispatcher, m.sender, 'no_sink', 'must be at a sink (bathroom)');
    return;
  }
  state.washingUntilTick ??= {};
  state.washingUntilTick[player.userId] = tick + TICK_RATE * 3;
  let cleaned = false;
  // Clear bloody from the equipped item (the weapon you used).
  const equipId = player.inventory.equipped;
  if (equipId) {
    const idx = player.inventory.items.findIndex((it) => it.instanceId === equipId);
    const inst = idx >= 0 ? player.inventory.items[idx] : undefined;
    if (inst?.data?.['bloody']) {
      const next = { ...inst.data };
      delete next['bloody'];
      const updated = { ...inst, data: next };
      updatePlayer(state, player.userId, { inventory: {
        ...player.inventory,
        items: player.inventory.items.map((it) => (it.instanceId === equipId ? updated : it)),
      } });
      sendInvDelta(dispatcher, state, m.sender, { upserted: [updated] });
      // Re-broadcast moved so equippedItemBloody updates for onlookers.
      broadcastPlayerMoved(dispatcher, player, tick, state);
      cleaned = true;
    }
  }
  broadcastFxSound(dispatcher, 'writing', player.x, player.y, 0.4);
  if (!cleaned) {
    // No bloody item — still ran the verb; tell them, no need to error.
    sendError(dispatcher, m.sender, 'nothing_to_wash', 'nothing bloody to wash');
  }
}

// ---------- sprint ----------

const SPRINT_DRAIN_INTERVAL_TICKS = 5; // 0.5s per stamina point at 10Hz
const SPRINT_MIN_STAMINA = 5;

function handleSprintToggle(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  const req = parseBody<C2SSprintToggle>(m.data);
  if (!req) return;
  state.sprinting ??= {};
  state.lastSprintDrainTick ??= {};
  if (req.on) {
    if (player.stamina < SPRINT_MIN_STAMINA) {
      sendError(dispatcher, m.sender, 'no_stamina', 'too tired to sprint');
      return;
    }
    state.sprinting[player.userId] = true;
    state.lastSprintDrainTick[player.userId] = state.tickN;
  } else {
    delete state.sprinting[player.userId];
    delete state.lastSprintDrainTick[player.userId];
  }
}

// ---------- plant on body ----------

/**
 * Plant an inventory item onto a target — adjacent corpse or adjacent
 * KO'd / dead-but-not-corpsed player. The item moves out of the planter's
 * inventory and into the target's contents. Core murder-mystery flavour:
 * frame the bloody knife on someone else.
 */
function handlePlantItem(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  const req = parseBody<C2SPlantItem>(m.data);
  if (!req || !req.target) return;
  const inst = player.inventory.items.find((it) => it.instanceId === req.instanceId);
  if (!inst) return;
  if (req.target.kind === 'corpse') {
    const c = state.corpses[req.target.corpseId];
    if (!c) return;
    if (Math.max(Math.abs(c.x - player.x), Math.abs(c.y - player.y)) > 1) {
      sendError(dispatcher, m.sender, 'too_far', 'corpse not adjacent');
      return;
    }
    const removed = removeItem(player.inventory, inst.instanceId);
    if (!removed) return;
    updatePlayer(state, player.userId, { inventory: removed.inventory });
    c.contents = [...c.contents, removed.removed];
    sendInvDelta(dispatcher, state, m.sender, {
      removed: [inst.instanceId],
      hotkeys: removed.inventory.hotkeys,
      equipped: removed.inventory.equipped,
      weight: removed.inventory.weight,
    });
    sendCorpseContents(dispatcher, m.sender, c);
    return;
  }
  // target.kind === 'player' — only KO'd or downed targets
  const target = state.players[req.target.userId];
  if (!target) return;
  if (Math.max(Math.abs(target.x - player.x), Math.abs(target.y - player.y)) > 1) {
    sendError(dispatcher, m.sender, 'too_far', 'target not adjacent');
    return;
  }
  const ko = (state.koUntilTick?.[target.userId] ?? 0) > state.tickN;
  if (target.isAlive && !ko) {
    sendError(dispatcher, m.sender, 'target_awake', 'target is conscious');
    return;
  }
  const r = addItem(target.inventory, inst.itemId, inst.count, inst.data);
  if (!r) {
    sendError(dispatcher, m.sender, 'too_heavy', 'target inventory is full');
    return;
  }
  target.inventory = r.inventory;
  const removed2 = removeItem(player.inventory, inst.instanceId);
  if (!removed2) return;
  updatePlayer(state, player.userId, { inventory: removed2.inventory });
  sendInvDelta(dispatcher, state, m.sender, {
    removed: [inst.instanceId],
    hotkeys: removed2.inventory.hotkeys,
    equipped: removed2.inventory.equipped,
    weight: removed2.inventory.weight,
  });
  // Refresh the target's own inventory if they're still connected.
  const targetPres = state.presences[target.userId];
  if (targetPres) sendInvFull(dispatcher, state, targetPres);
}

// ---------- inject target (syringe on adjacent player) ----------

function handleInjectTarget(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  const req = parseBody<C2SInjectTarget>(m.data);
  if (!req) return;
  const target = state.players[req.targetUserId];
  if (!target || !target.isAlive) return;
  if (target.userId === player.userId) {
    sendError(dispatcher, m.sender, 'self_target', 'use C2S_INV_USE for self-injection');
    return;
  }
  if (Math.max(Math.abs(target.x - player.x), Math.abs(target.y - player.y)) > 1) {
    sendError(dispatcher, m.sender, 'too_far', 'target not adjacent');
    return;
  }
  const inst = player.inventory.items.find((it) => it.instanceId === req.instanceId);
  if (!inst || inst.itemId !== 'syringe') return;
  const filled = inst.data?.['filled'];
  if (!filled) {
    sendError(dispatcher, m.sender, 'empty_syringe', 'fill the syringe first');
    return;
  }
  if (filled === 'Regenerative') {
    target.hp = Math.min(target.maxHp, target.hp + 30);
    broadcastPlayerHealth(dispatcher, target);
    const tp = state.presences[target.userId];
    if (tp) sendPlayerHP(dispatcher, tp, target);
  } else if (filled === 'Cure') {
    if (state.scheduledInfections) {
      const before = state.scheduledInfections.length;
      state.scheduledInfections = state.scheduledInfections.filter(
        (s) => s.userId !== target.userId,
      );
      if (state.scheduledInfections.length < before) {
        broadcastAnnouncement(dispatcher, {
          kind: 'mode_event',
          message: `${player.displayName} cured ${target.displayName}.`,
        });
      }
    }
  } else if (filled === 'Sedative') {
    state.slowedUntilTick ??= {};
    state.slowedUntilTick[target.userId] = state.tickN + TICK_RATE * 10;
    broadcastAnnouncement(dispatcher, {
      kind: 'mode_event',
      message: `${target.displayName} stumbles, drugged.`,
    });
    pushStatus(state, dispatcher, target);
  }
  consumeCharge(state, dispatcher, m.sender, player, inst.instanceId);
}

// ---------- shove ----------

const SHOVE_COOLDOWN_TICKS = TICK_RATE; // 1s

/**
 * Push the player one tile in front of you. Non-damaging crowd control.
 * Won't push into walls or onto another occupied tile.
 */
function handleShove(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  tick: number,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  if ((state.lastShoveTick?.[player.userId] ?? 0) + SHOVE_COOLDOWN_TICKS > tick) return;
  const delta = DIRECTION_DELTAS[player.facing];
  if (!delta) return;
  const fx = player.x + delta.dx;
  const fy = player.y + delta.dy;
  let target: PlayerInGame | null = null;
  for (const uid in state.players) {
    const p = state.players[uid];
    if (p && p.isAlive && p.x === fx && p.y === fy) {
      target = p;
      break;
    }
  }
  if (!target) {
    sendError(dispatcher, m.sender, 'no_target', 'no one to shove');
    return;
  }
  const tx = target.x + delta.dx;
  const ty = target.y + delta.dy;
  if (!tilemap.isPassable(tx, ty)) return;
  for (const uid in state.players) {
    const p = state.players[uid];
    if (p && p.userId !== target.userId && p.x === tx && p.y === ty) return;
  }
  state.lastShoveTick ??= {};
  state.lastShoveTick[player.userId] = tick;
  target.x = tx;
  target.y = ty;
  broadcastPlayerMoved(dispatcher, target, tick, state);
  broadcastFxSound(dispatcher, 'punch', target.x, target.y, 0.5);
}

// ---------- PDA SMS ----------

const PDA_MAX_BODY = 200;

/**
 * Anonymous PDA-to-PDA messaging. Both sender and target must hold a PDA
 * in their inventory. Recipient sees an "ANON" S2CPaperReceived — same
 * delivery path as paper airplanes so the client doesn't need new wiring.
 */
function handlePdaSend(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const sender = state.players[m.sender.userId];
  if (!sender || !sender.isAlive) return;
  const req = parseBody<C2SPdaSend>(m.data);
  if (!req || !req.targetUserId) return;
  const body = String(req.body ?? '')
    .trim()
    .slice(0, PDA_MAX_BODY);
  if (body.length === 0) return;
  const senderHasPda = sender.inventory.items.some((it) => it.itemId === 'pda');
  if (!senderHasPda) {
    sendError(dispatcher, m.sender, 'no_pda', 'you need a PDA to send messages');
    return;
  }
  const target = state.players[req.targetUserId];
  if (!target || !target.isAlive) return;
  const targetHasPda = target.inventory.items.some((it) => it.itemId === 'pda');
  if (!targetHasPda) {
    sendError(dispatcher, m.sender, 'target_no_pda', 'recipient is not carrying a PDA');
    return;
  }
  const targetPres = state.presences[target.userId];
  if (!targetPres) return;
  const payload: S2CPaperReceived = { fromDisplayName: 'ANON', text: body };
  dispatcher.broadcastMessage(
    OpCode.S2C_PAPER_RECEIVED,
    JSON.stringify(payload),
    [targetPres],
    null,
    true,
  );
}

// ---------- container push ----------

/**
 * Push a non-stationed container one tile in your facing direction.
 * Stationed containers (Counter, Locker, Office_Desk, Refrigerator) are
 * fixed by design — only `/obj/Containers/*` is pushable.
 */
function handleContainerPush(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  const req = parseBody<C2SContainerPush>(m.data);
  if (!req) return;
  // Resolve container by coords (matches C2S_CONTAINER_LOOK addressing).
  let c: import('../world/containers.js').ContainerInstance | undefined;
  for (const cid in state.containers) {
    const ct = state.containers[cid];
    if (ct && ct.x === req.x && ct.y === req.y) {
      c = ct;
      break;
    }
  }
  if (!c) return;
  if (!c.kind.startsWith('/obj/Containers/')) {
    sendError(dispatcher, m.sender, 'stationed', 'this container is fixed');
    return;
  }
  if (Math.max(Math.abs(c.x - player.x), Math.abs(c.y - player.y)) > 1) {
    sendError(dispatcher, m.sender, 'too_far', 'container not adjacent');
    return;
  }
  const delta = DIRECTION_DELTAS[player.facing];
  if (!delta) return;
  // Authoritative check: the container must actually be the tile IN FRONT
  // of the player (not behind / sideways). Client's facing can lag the
  // server by a tick during rapid input, which would otherwise make the
  // server happily push a sideways container "in facing direction" — which
  // visually reads as pulling it toward the player.
  if (c.x !== player.x + delta.dx || c.y !== player.y + delta.dy) {
    return;
  }
  const nx = c.x + delta.dx;
  const ny = c.y + delta.dy;
  if (!tilemap.isPassable(nx, ny)) return;
  for (const cid in state.containers) {
    const other = state.containers[cid];
    if (other && other !== c && other.x === nx && other.y === ny) return;
  }
  for (const uid in state.players) {
    const o = state.players[uid];
    if (o && o.isAlive && o.x === nx && o.y === ny) return;
  }
  const fromX = c.x;
  const fromY = c.y;
  state.containers[c.containerId] = { ...c, x: nx, y: ny };
  const payload: S2CContainerMoved = {
    containerId: c.containerId,
    fromX,
    fromY,
    x: nx,
    y: ny,
  };
  dispatcher.broadcastMessage(
    OpCode.S2C_CONTAINER_MOVED,
    JSON.stringify(payload),
    null,
    null,
    true,
  );
  broadcastFxSound(dispatcher, 'doormetal', nx, ny, 0.4);
}

// ---------- corpse push ----------

/**
 * Push a corpse one tile in your facing direction. Single-shot; distinct
 * from C2S_PULL_TOGGLE which sets up continuous drag.
 */
function handleCorpsePush(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  const req = parseBody<C2SCorpsePush>(m.data);
  if (!req) return;
  const c = state.corpses[req.corpseId];
  if (!c) return;
  if (Math.max(Math.abs(c.x - player.x), Math.abs(c.y - player.y)) > 1) {
    sendError(dispatcher, m.sender, 'too_far', 'corpse not adjacent');
    return;
  }
  const delta = DIRECTION_DELTAS[player.facing];
  if (!delta) return;
  const nx = c.x + delta.dx;
  const ny = c.y + delta.dy;
  if (!tilemap.isPassable(nx, ny)) return;
  c.x = nx;
  c.y = ny;
  // Re-broadcast the corpse with its new position. Same op as spawn —
  // clients merge by corpseId.
  broadcastCorpseUpdate(dispatcher, c);
}

// ---------- light switches / fuse box ----------

const EYE_DEAL_OFFER_TIMEOUT_TICKS = TICK_RATE * 30;

/**
 * Toggle a light-switch's tag in `state.lightsOff`. Player must be adjacent
 * to a switch matching the tag. Broadcasts the new full off-set so clients
 * darken the affected area.
 */
function handleLightSwitchToggle(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  const req = parseBody<C2SLightSwitchToggle>(m.data);
  if (!req?.tag) return;
  const sw = tilemap.adjacentLightSwitch(player.x, player.y);
  if (!sw || sw.tag !== req.tag) {
    sendError(dispatcher, m.sender, 'no_switch', 'no light switch adjacent');
    return;
  }
  state.lightsOff ??= {};
  if (state.lightsOff[req.tag]) delete state.lightsOff[req.tag];
  else state.lightsOff[req.tag] = true;
  broadcastLightState(dispatcher, state);
}

function broadcastLightState(dispatcher: nkruntime.MatchDispatcher, state: PyrceMatchState): void {
  const offTags = Object.keys(state.lightsOff ?? {});
  const payload: S2CLightState = { offTags };
  dispatcher.broadcastMessage(OpCode.S2C_LIGHT_STATE, JSON.stringify(payload), null, null, true);
}

// ---------- security cameras / monitors / tapes ----------

/**
 * View a security camera. Player must be adjacent to a Monitor.
 * Replies with the camera's tile coords; client briefly pans the camera there.
 */
function handleCameraView(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  if (!tilemap.isAdjacentToMonitor(player.x, player.y)) {
    sendError(dispatcher, m.sender, 'no_monitor', 'must stand next to a security monitor');
    return;
  }
  const req = parseBody<C2SCameraView>(m.data);
  if (!req?.tag) return;
  const cam = tilemap.cameraByTag(req.tag);
  if (!cam) {
    sendError(dispatcher, m.sender, 'no_camera', 'unknown camera tag');
    return;
  }
  const payload: S2CCameraFeed = { tag: req.tag, x: cam.x, y: cam.y, durationMs: 6000 };
  dispatcher.broadcastMessage(
    OpCode.S2C_CAMERA_FEED,
    JSON.stringify(payload),
    [m.sender],
    null,
    true,
  );
}

/**
 * View tapes from an adjacent monitor. In Normal/Witch/Doppelganger modes,
 * reveals the killer's hair color (or 'deleted' if Delete_Tapes was used,
 * or 'wrong_mode' for modes where tapes don't help).
 */
const TAPE_HAIR_COLORS = ['#222222', '#553311', '#cc9966', '#aa3333', '#dddddd'];

function handleTapeView(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  if (!tilemap.isAdjacentToMonitor(player.x, player.y)) {
    sendError(dispatcher, m.sender, 'no_monitor', 'must stand next to a security monitor');
    return;
  }
  const mode = effectiveModeId(state);
  const tapeRelevant = mode === 'normal' || mode === 'witch' || mode === 'doppelganger';
  let result: string;
  if (!tapeRelevant) {
    result = 'wrong_mode';
  } else if (state.tapesDeleted) {
    result = 'deleted';
  } else {
    // Find the killer / witch / doppelganger to source a "hair color".
    let suspect: PlayerInGame | null = null;
    for (const uid in state.players) {
      const p = state.players[uid];
      if (!p) continue;
      if (p.roleId === 'killer' || p.roleId === 'witch' || p.roleId === 'doppelganger') {
        suspect = p;
        break;
      }
    }
    if (!suspect) {
      result = 'no_killer';
    } else {
      // Stable per-suspect "hair color" from a small palette so the answer
      // doesn't change between views in the same round.
      let hash = 0;
      for (let i = 0; i < suspect.userId.length; i++) {
        hash = (hash * 31 + suspect.userId.charCodeAt(i)) >>> 0;
      }
      result = TAPE_HAIR_COLORS[hash % TAPE_HAIR_COLORS.length] ?? '#666666';
    }
  }
  const payload: S2CTapeResult = { result };
  dispatcher.broadcastMessage(
    OpCode.S2C_TAPE_RESULT,
    JSON.stringify(payload),
    [m.sender],
    null,
    true,
  );
}

/**
 * Killer-only verb to wipe the tapes. Adjacent monitor required. Once
 * deleted, all subsequent C2S_TAPE_VIEW return 'deleted'.
 */
function handleTapeDelete(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  if (!tilemap.isAdjacentToMonitor(player.x, player.y)) {
    sendError(dispatcher, m.sender, 'no_monitor', 'must stand next to a security monitor');
    return;
  }
  if (player.roleId !== 'killer' && player.roleId !== 'witch' && player.roleId !== 'doppelganger') {
    sendError(dispatcher, m.sender, 'wrong_role', 'only the antagonist can delete tapes');
    return;
  }
  state.tapesDeleted = true;
}

// ---------- shinigami eye deal ----------

/**
 * Shinigami offers Eyes to an adjacent player who's touched the death note.
 * Sends an S2C_EYE_OFFER to the target; they reply with C2S_ACCEPT_EYES.
 */
function handleOfferEyes(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const sender = state.players[m.sender.userId];
  if (!sender || !sender.isAlive) return;
  if (sender.roleId !== 'shinigami') {
    sendError(dispatcher, m.sender, 'wrong_role', 'only Shinigami can offer Eyes');
    return;
  }
  const req = parseBody<C2SOfferEyes>(m.data);
  if (!req?.targetUserId) return;
  const target = state.players[req.targetUserId];
  if (!target || !target.isAlive || target.userId === sender.userId) return;
  if (Math.max(Math.abs(target.x - sender.x), Math.abs(target.y - sender.y)) > 5) {
    sendError(dispatcher, m.sender, 'too_far', 'target out of range');
    return;
  }
  const targetPres = state.presences[target.userId];
  if (!targetPres) return;
  state.eyeOffers ??= {};
  state.eyeOffers[target.userId] = {
    fromUserId: sender.userId,
    expiresAtTick: state.tickN + EYE_DEAL_OFFER_TIMEOUT_TICKS,
  };
  const payload: S2CEyeOffer = { fromUserId: sender.userId, fromDisplayName: sender.displayName };
  dispatcher.broadcastMessage(
    OpCode.S2C_EYE_OFFER,
    JSON.stringify(payload),
    [targetPres],
    null,
    true,
  );
}

/**
 * Target accepts (or declines) a pending eye-deal offer. On accept: HP
 * halved, shinigamiEyes flag set (sees real names), scheduled death at a
 * fixed future game minute (DM scaled by the round-start hour, mid-game
 * accepts get later timers).
 */
function handleAcceptEyes(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  const req = parseBody<C2SAcceptEyes>(m.data);
  if (!req) return;
  const offer = state.eyeOffers?.[player.userId];
  if (!offer) {
    sendError(dispatcher, m.sender, 'no_offer', 'no eye-deal offer pending');
    return;
  }
  if (state.eyeOffers) delete state.eyeOffers[player.userId];
  if (!req.accept) return;
  player.hp = Math.max(1, Math.floor(player.hp / 2));
  player.shinigamiEyes = true;
  broadcastPlayerHealth(dispatcher, player);
  const pres = state.presences[player.userId];
  if (pres) sendPlayerHP(dispatcher, pres, player);
  // Schedule a death some hours later (DM table). Use 6h after the offer
  // accept for simplicity — feels long enough for the recipient to act on
  // their new vision before the trade comes due.
  const deathInMinutes = Math.floor(currentGameMinutes(state) + 6 * 60);
  state.scheduledEyeDeaths ??= [];
  state.scheduledEyeDeaths.push({ userId: player.userId, atGameMinute: deathInMinutes });
  broadcastAnnouncement(dispatcher, {
    kind: 'mode_event',
    message: `${player.displayName} has been visited by a Shinigami.`,
  });
}

function currentGameMinutes(state: PyrceMatchState): number {
  if (!state.clock) return 0;
  return totalGameMinutes(state.clock, state.tickN, TICK_RATE);
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

/** Mode-specific opening announcement, mirroring DM `GameStarter.dm` flavor. */
function openingFlavorFor(modeId: string): string {
  switch (modeId) {
    case 'normal':
      return 'Warning: dead body located on the premises. Simple program analysis suggests murder. Facility locked down until authorities arrive.';
    case 'doppelganger':
      return 'Warning: dead body located. The face is missing. Whoever did this could be wearing it.';
    case 'death_note_classic':
      return 'Lockdown Malfunction: a teacher has died of stress. Simple program analysis is inconclusive.';
    case 'witch':
      return 'Warning: dead body located. The wounds make no anatomical sense.';
    case 'zombie':
      return 'Warning: dead body located. Bite and scratch marks. Containment recommended.';
    case 'vampire':
      return 'Warning: dead body located. The body has been drained of blood; marks on the neck.';
    case 'ghost':
      return 'Warning: dead body located. No suspect was witnessed entering or leaving the room.';
    case 'extended':
      return 'Lockdown initiated. Make it to dawn.';
    case 'secret':
      return 'Lockdown initiated. Something is wrong here.';
    default:
      return 'A new round begins.';
  }
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
      targetDisplayName: targetPlayer?.displayName ?? '?',
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
        victimDisplayName: targetPlayer.displayName,
        victimHairId: targetPlayer.hairId,
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
        message: `${targetPlayer.displayName} was vote-kicked from the round.`,
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
    state.endingResetAtTick = state.tickN + TICK_RATE * 10;
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
 * Vending machine: spend 100 yen for one soda. The two non-soda vending
 * sprites are placeable cosmetics and are accepted here as a no-op.
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
  updatePlayer(state, player.userId, { inventory: inv });
  // Grant the soda.
  const r = addItem(player.inventory, 'soda', 1);
  if (r) updatePlayer(state, player.userId, { inventory: r.inventory });
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
  const locked = state.lockedDoors?.[key] === true;
  if (locked) {
    const hasCard = player.inventory.items.some(
      (it) => it.itemId === 'key_card' || it.itemId === 'key_card_rare',
    );
    if (!hasCard) {
      broadcastFxSound(dispatcher, 'door_locked', req.x, req.y, 0.6);
      sendError(dispatcher, m.sender, 'door_locked', 'door is locked');
      return;
    }
    if (state.lockedDoors) delete state.lockedDoors[key];
  }
  const isOpen = state.openDoors[key] === true;
  state.openDoors[key] = !isOpen;
  const payload: S2CDoorState = { x: req.x, y: req.y, open: !isOpen };
  dispatcher.broadcastMessage(OpCode.S2C_DOOR_STATE, JSON.stringify(payload), null, null, true);
  broadcastFxSound(dispatcher, 'doormetal', req.x, req.y, 0.6);
}

/**
 * Throw the equipped weapon. Walks tiles in facing dir up to weapon range
 * (capped at 6); first alive player along the line takes weapon.damage.
 * The weapon drops as a ground item where it landed.
 */
function handleThrow(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  tick: number,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player || !player.isAlive) return;
  if ((state.koUntilTick?.[m.sender.userId] ?? 0) > tick) return;
  if ((state.frozenUntilTick?.[m.sender.userId] ?? 0) > tick) return;
  const equippedId = player.inventory.equipped;
  if (!equippedId) {
    sendError(dispatcher, m.sender, 'no_equip', 'nothing to throw');
    return;
  }
  const inst = player.inventory.items.find((i) => i.instanceId === equippedId);
  const def = inst ? ITEMS[inst.itemId] : undefined;
  if (!inst || !def?.weapon) {
    sendError(dispatcher, m.sender, 'not_throwable', 'this item cannot be thrown');
    return;
  }
  const range = Math.min(6, Math.max(2, def.weapon.range * 2));
  const delta = DIRECTION_DELTAS[player.facing];
  const path: Array<{ x: number; y: number }> = [];
  let hit: PlayerInGame | null = null;
  if (delta) {
    for (let step = 1; step <= range; step++) {
      const tx = player.x + delta.dx * step;
      const ty = player.y + delta.dy * step;
      if (!tilemap.isPassable(tx, ty)) break;
      path.push({ x: tx, y: ty });
      for (const otherId in state.players) {
        const o = state.players[otherId];
        if (!o || o === player || !o.isAlive) continue;
        if (o.x === tx && o.y === ty) {
          hit = o;
          break;
        }
      }
      if (hit) break;
    }
  }
  // Reuse the feather fx as a generic projectile path.
  const fx: S2CFxFeather = { path };
  dispatcher.broadcastMessage(OpCode.S2C_FX_FEATHER, JSON.stringify(fx), null, null, true);
  // Remove the weapon from inventory.
  const removed = removeItem(player.inventory, inst.instanceId);
  if (removed) {
    updatePlayer(state, player.userId, { inventory: removed.inventory });
    sendInvFull(dispatcher, state, m.sender);
  }
  // Drop where it landed (or at attacker's tile if no path).
  const landing = path[path.length - 1] ?? { x: player.x, y: player.y };
  const ground = fromInstance(inst, landing.x, landing.y);
  state.groundItems[ground.groundItemId] = ground;
  broadcastGroundItemDelta(dispatcher, { upserted: [toPublicGroundItem(ground)] });
  if (hit) {
    hit.hp = Math.max(0, hit.hp - def.weapon.damage);
    broadcastPlayerHealth(dispatcher, hit);
    const pres = state.presences[hit.userId];
    if (pres) sendPlayerHP(dispatcher, pres, hit);
    if (hit.hp === 0 && def.weapon.lethal) {
      hit.isAlive = false;
      hit.isWatching = true;
      const corpse: Corpse = {
        corpseId: newCorpseId(),
        victimUserId: hit.userId,
        victimDisplayName: hit.displayName,
        victimHairId: hit.hairId,
        victimRealName: hit.realName,
        killerUserId: player.userId,
        cause: `Thrown ${def.name}`,
        x: hit.x,
        y: hit.y,
        contents: hit.inventory.items.slice(),
        discovered: false,
        discoveredByUserId: null,
      };
      hit.inventory = {
        items: [],
        hotkeys: [null, null, null, null, null],
        equipped: null,
        weight: 0,
        weightCap: hit.inventory.weightCap,
      };
      state.corpses[corpse.corpseId] = corpse;
      broadcastPlayerDied(dispatcher, hit, player.userId, `Thrown ${def.name}`);
      broadcastCorpseUpdate(dispatcher, corpse);
      broadcastFxSound(dispatcher, 'body_fall', hit.x, hit.y, 0.7);
    }
  }
}

/**
 * Lets a player join an in-progress match as a non-participating Watcher.
 * They get the special Watcher spawn, are flagged dead+watching so they
 * see all chat channels, and don't count toward win conditions.
 */
function handleJoinAsWatcher(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  // Already a player — skip; they're alive, not a watcher.
  if (state.players[m.sender.userId]) return;
  const spawn = tilemap.spawnsById.get('Watcher');
  if (!spawn) return;
  const demo =
    state.lobbyDemographics[m.sender.userId] ??
    rollUniqueDemographics(Object.values(state.lobbyDemographics));
  const watcher = newPlayerInGame(m.sender.userId, m.sender.username, spawn.x, spawn.y, demo);
  watcher.roleId = 'watcher';
  watcher.isAlive = false;
  watcher.isWatching = true;
  watcher.hp = 0;
  state.players[m.sender.userId] = watcher;
  sendInitialSnapshot(dispatcher, state, m.sender);
  sendInvFull(dispatcher, state, m.sender);
  broadcastAnnouncement(dispatcher, {
    kind: 'system',
    message: `${watcher.displayName} joined as a Watcher.`,
  });
}

function handleDoorCodeEntry(
  state: PyrceMatchState,
  m: nkruntime.MatchMessage,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  if (state.phase !== MatchPhase.InGame) return;
  const player = state.players[m.sender.userId];
  if (!player) return;
  const req = parseBody<C2SDoorCodeEntry>(m.data);
  if (!req) return;
  if (Math.max(Math.abs(req.x - player.x), Math.abs(req.y - player.y)) > 1) {
    sendError(dispatcher, m.sender, 'too_far', 'door not adjacent');
    return;
  }
  const key = `${req.x},${req.y}`;
  if (state.lockedDoors?.[key] !== true) {
    sendError(dispatcher, m.sender, 'not_locked', 'door is not locked');
    return;
  }
  if (req.code !== state.doorCode) {
    sendError(dispatcher, m.sender, 'wrong_code', 'wrong code');
    broadcastFxSound(dispatcher, 'door_locked', req.x, req.y, 0.6);
    return;
  }
  delete state.lockedDoors[key];
  state.openDoors ??= {};
  state.openDoors[key] = true;
  const payload: S2CDoorState = { x: req.x, y: req.y, open: true };
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
    updatePlayer(state, player.userId, { inventory: result.inventory });
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
  updatePlayer(state, player.userId, { inventory: r.inventory });
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
  updatePlayer(state, player.userId, { inventory: r.inventory });
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
  if (state.phase === MatchPhase.Ending) return;
  const senderPresence = state.presences[m.sender.userId];
  if (!senderPresence) return;
  const req = parseBody<C2SChat>(m.data);
  if (!req || !req.channel) return;
  const body = sanitizeChatBody(req.body);
  if (body.length === 0) return;

  // Lobby chat: every presence hears it as OOC; no role gating, no
  // proximity. Once InGame starts, normal routing applies.
  if (state.phase === MatchPhase.Lobby) {
    const recipients: nkruntime.Presence[] = [];
    for (const uid in state.presences) {
      const p = state.presences[uid];
      if (p) recipients.push(p);
    }
    const lobbyPayload: S2CChatMessage = {
      channel: ChatChannel.OOC,
      fromUserId: m.sender.userId,
      fromDisplayName: state.players[m.sender.userId]?.displayName ?? m.sender.username,
      body,
      bubble: false,
      tickN: tick,
    };
    dispatcher.broadcastMessage(
      OpCode.S2C_CHAT_MESSAGE,
      JSON.stringify(lobbyPayload),
      recipients,
      null,
      true,
    );
    return;
  }

  const sender = state.players[m.sender.userId];
  if (!sender) return;

  const { recipients, bubble } = routeChat(state, sender, req.channel);
  if (recipients.length === 0) return;

  const payload: S2CChatMessage = {
    channel: req.channel,
    fromUserId: sender.userId,
    fromDisplayName: sender.displayName,
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
  if ((state.koUntilTick?.[m.sender.userId] ?? 0) > tick) return;

  const req = parseBody<C2SAttack>(m.data) ?? {};
  if (req.dir) attacker.facing = req.dir as Facing;

  const result = resolveAttack(state, attacker, tick, req.dir as Facing | undefined);
  if (!result.swung) return;

  // Self-only stamina + facing snapshot.
  sendStamina(dispatcher, m.sender, attacker);
  // We send the attacker's facing as a movement broadcast so other clients
  // turn the sprite to face the swing direction. Coordinates unchanged.
  broadcastPlayerMoved(dispatcher, attacker, tick, state);
  // Visual swing fx to all viewers.
  const swingPayload: S2CFxSwing = { userId: attacker.userId, facing: attacker.facing };
  dispatcher.broadcastMessage(OpCode.S2C_FX_SWING, JSON.stringify(swingPayload), null, null, true);

  if (!result.hitUserId) return;
  const victim = state.players[result.hitUserId];
  if (!victim) return;

  // Miss: 10% evade roll inside resolveAttack returns damage=0. Skip
  // KO/bleed/health broadcast — the swing fx already played above.
  if (result.outcome === 'miss') {
    broadcastFxSound(dispatcher, 'punch', attacker.x, attacker.y, 0.3);
    return;
  }

  // KO non-lethal hits instead of leaving the victim conscious at 1 HP.
  // resolveAttack already capped HP at 1 for non-lethal weapons; we
  // augment with a 6-second knockout so taser/punch/etc. matter.
  const weaponName = result.weaponName.toLowerCase();
  if (!result.killed && !weaponName.includes('fists')) {
    state.koUntilTick ??= {};
    state.koUntilTick[victim.userId] = tick + TICK_RATE * 6;
    pushStatus(state, dispatcher, victim);
  }
  // Bleeding: knife / billhook / axe / spear apply ~10s of bleed.
  if (BLEEDING_WEAPONS.some((w) => weaponName.includes(w))) {
    state.bleedUntilTick ??= {};
    state.bleedUntilTick[victim.userId] = tick + TICK_RATE * 10;
    pushStatus(state, dispatcher, victim);
  }

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
      broadcastAnnouncement(dispatcher, {
        kind: 'mode_event',
        message: `${attacker.displayName} snickers as butterflies emerge.`,
      });
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
        searcherDisplayName: player.displayName,
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
      reason: `${responder.displayName} declined your search`,
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
  updatePlayer(state, player.userId, { inventory: added.inventory });
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
        // DM-style: 5s before the kill, whisper the victim that their
        // name's been written. Once-only via the warned flag.
        if (!s.warned && s.warnAtTick !== undefined && tick >= s.warnAtTick) {
          s.warned = true;
          const victimP = state.players[s.victimUserId];
          const pres = state.presences[s.victimUserId];
          if (victimP && pres) {
            const ann: S2CAnnouncement = {
              kind: 'mode_event',
              message: 'Your name was written. You have only seconds left.',
            };
            dispatcher.broadcastMessage(
              OpCode.S2C_ANNOUNCEMENT,
              JSON.stringify(ann),
              [pres],
              null,
              true,
            );
          }
        }
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
        victimDisplayName: victim.displayName,
        victimHairId: victim.hairId,
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

  // Eye-deal scheduled deaths — half-life trade comes due. Compares the
  // victim's atGameMinute to the current game-clock minute.
  if (state.scheduledEyeDeaths && state.scheduledEyeDeaths.length > 0 && state.clock) {
    const nowMin = totalGameMinutes(state.clock, tick, TICK_RATE);
    const remaining: typeof state.scheduledEyeDeaths = [];
    for (const s of state.scheduledEyeDeaths) {
      if (nowMin < s.atGameMinute) {
        remaining.push(s);
        continue;
      }
      const victim = state.players[s.userId];
      if (!victim || !victim.isAlive) continue;
      victim.hp = 0;
      victim.isAlive = false;
      victim.isWatching = true;
      const corpse: Corpse = {
        corpseId: newCorpseId(),
        victimUserId: victim.userId,
        victimDisplayName: victim.displayName,
        victimHairId: victim.hairId,
        victimRealName: victim.realName,
        killerUserId: null,
        cause: 'Shinigami Eye Deal',
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
      broadcastPlayerDied(dispatcher, victim, null, 'Shinigami Eye Deal');
      broadcastCorpseUpdate(dispatcher, corpse);
      broadcastFxSound(dispatcher, 'body_fall', victim.x, victim.y, 0.7);
      logger.info('eye-deal death: %s', victim.userId);
    }
    state.scheduledEyeDeaths = remaining;
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
        message: `${target.displayName} stirs back to life…`,
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
        message: `${target.displayName} has turned!`,
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
      victimDisplayName: p.displayName,
      victimHairId: p.hairId,
      victimRealName: p.realName,
      killerUserId: null,
      cause: 'Disconnect',
      x: p.x,
      y: p.y,
      contents: p.inventory.items.slice(),
      discovered: false,
      discoveredByUserId: null,
    };
    updatePlayer(state, p.userId, { inventory: {
      items: [],
      hotkeys: [null, null, null, null, null],
      equipped: null,
      weight: 0,
      weightCap: p.inventory.weightCap,
    } });
    state.corpses[corpse.corpseId] = corpse;
    broadcastPlayerDied(dispatcher, p, null, 'Disconnect');
    broadcastCorpseUpdate(dispatcher, corpse);
    broadcastAnnouncement(dispatcher, {
      kind: 'system',
      message: `${p.displayName} disconnected and was lost to the round.`,
    });
    logger.info('disconnect kill: %s after %d ticks', p.userId, tick - at);
  }
}

/**
 * Whisperer directional sense: each whisperer gets a self-only S2C_GHOST_SENSE
 * indicating where the ghost is roughly. Buckets distance to 5/15/30 and
 * rounds direction to 8-way.
 */
function broadcastGhostSenseToWhisperers(
  state: PyrceMatchState,
  dispatcher: nkruntime.MatchDispatcher,
): void {
  let ghost: PlayerInGame | null = null;
  for (const uid in state.players) {
    const p = state.players[uid];
    if (p?.roleId === 'ghost' && p.isAlive) {
      ghost = p;
      break;
    }
  }
  for (const uid in state.players) {
    const w = state.players[uid];
    if (!w || w.roleId !== 'whisperer' || !w.isAlive) continue;
    const presence = state.presences[uid];
    if (!presence) continue;
    let payload: S2CGhostSense;
    if (!ghost) {
      payload = { direction: null, distance: null };
    } else {
      const dx = ghost.x - w.x;
      const dy = ghost.y - w.y;
      const direction = bearing(dx, dy);
      const cheb = Math.max(Math.abs(dx), Math.abs(dy));
      const bucket = cheb <= 5 ? 5 : cheb <= 15 ? 15 : 30;
      payload = { direction, distance: bucket };
    }
    dispatcher.broadcastMessage(
      OpCode.S2C_GHOST_SENSE,
      JSON.stringify(payload),
      [presence],
      null,
      true,
    );
  }
}

function bearing(dx: number, dy: number): S2CGhostSense['direction'] {
  if (dx === 0 && dy === 0) return null;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  // Map screen-coord angle (0=East, 90=South) to compass.
  if (angle >= -22.5 && angle < 22.5) return 'E';
  if (angle >= 22.5 && angle < 67.5) return 'SE';
  if (angle >= 67.5 && angle < 112.5) return 'S';
  if (angle >= 112.5 && angle < 157.5) return 'SW';
  if (angle >= 157.5 || angle < -157.5) return 'W';
  if (angle >= -157.5 && angle < -112.5) return 'NW';
  if (angle >= -112.5 && angle < -67.5) return 'N';
  return 'NE';
}

/** Push a self-only status snapshot so the HUD can update its icons. */
function pushStatus(
  state: PyrceMatchState,
  dispatcher: nkruntime.MatchDispatcher,
  player: PlayerInGame,
): void {
  const pres = state.presences[player.userId];
  if (!pres) return;
  const tick = state.tickN;
  const payload: S2CPlayerStatus = {
    ko: (state.koUntilTick?.[player.userId] ?? 0) > tick,
    bleeding: (state.bleedUntilTick?.[player.userId] ?? 0) > tick,
    frozen: (state.frozenUntilTick?.[player.userId] ?? 0) > tick,
    infected: !!state.scheduledInfections?.some((s) => s.userId === player.userId),
  };
  dispatcher.broadcastMessage(
    OpCode.S2C_PLAYER_STATUS,
    JSON.stringify(payload),
    [pres],
    null,
    true,
  );
}

function newCorpseId(): string {
  return `corpse-${Math.random().toString(36).slice(2, 12)}`;
}

function pickRandomSpawn(): { x: number; y: number } {
  const list = tilemap.playerSpawns;
  return list[Math.floor(Math.random() * list.length)] ?? { x: 36, y: 66 };
}

/**
 * Seed the Detective's paper with the DM clue: "There's about an X% chance
 * a teacher in this school is Kira." X is rand(1,40).
 */
function seedDetectiveClue(state: PyrceMatchState): void {
  for (const uid of Object.keys(state.players)) {
    const p = state.players[uid];
    if (!p || p.roleId !== 'detective') continue;
    const sheet = p.inventory.items.find((i) => i.itemId === 'paper_sheet');
    if (!sheet) continue;
    const odds = 1 + Math.floor(Math.random() * 40);
    const text = `There is about a ${odds}% chance a teacher in this school is Kira. Keep this note confidential.`;
    const updated = { ...sheet, data: { ...(sheet.data ?? {}), text } };
    state.players[uid] = {
      ...p,
      inventory: {
        ...p.inventory,
        items: p.inventory.items.map((it) =>
          it.instanceId === sheet.instanceId ? updated : it,
        ),
      },
    };
  }
}

function relocateSpecialSpawns(state: PyrceMatchState): void {
  for (const userId of Object.keys(state.players)) {
    const p = state.players[userId];
    if (!p) continue;
    const target = SPECIAL_SPAWN_BY_ROLE[p.roleId];
    if (!target) continue;
    const spot = tilemap.spawnsById.get(target);
    if (!spot) continue;
    updatePlayer(state, userId, { x: spot.x, y: spot.y });
  }
}

/**
 * Spawn-id → classroom map. Mirrors GameStarter.dm:425-505: each numbered
 * spawn point belongs to a homeroom (A1, A2, B1, B2, C1, C2, D1, D2). The
 * School Computer / PDA roster groups players by classroom so survivors
 * can deduce who's missing room-by-room.
 */
const SPAWN_TO_CLASSROOM: { readonly [spawnId: string]: string } = {
  One: 'A1',
  Two: 'A1',
  Three: 'B1',
  Four: 'B1',
  Five: 'B2',
  Six: 'B2',
  Seven: 'C1',
  Eight: 'C1',
  Nine: 'C2',
  Ten: 'C2',
  Eleven: 'D1',
  Twelve: 'D1',
  Thirteen: 'D2',
  Fourteen: 'D2',
  Fifteen: 'A2',
  Sixteen: 'A2',
  Seventeen: 'A2',
  Eighteen: 'A1',
  Nineteen: 'A2',
  Twenty: 'B1',
  Twentyone: 'B2',
  Twentytwo: 'C1',
};

function assignSpawns(state: PyrceMatchState): void {
  const spawns = tilemap.playerSpawns;
  let i = 0;
  for (const userId in state.presences) {
    const presence = state.presences[userId];
    if (!presence) continue;
    const sp = spawns[i % spawns.length];
    if (!sp) continue;
    const demo =
      state.lobbyDemographics[userId] ??
      rollUniqueDemographics(Object.values(state.lobbyDemographics));
    const player = newPlayerInGame(userId, presence.username, sp.x, sp.y, demo);
    const room = SPAWN_TO_CLASSROOM[sp.id];
    if (room) player.classroom = room;
    state.players[userId] = player;
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
  // Doppelganger weapon-hide: a disguised doppel publishes a null
  // equippedItemId so onlookers don't see a knife in their hand.
  const isDisguisedDoppel =
    player.roleId === 'doppelganger' && !!player.roleData?.['disguiseAsUserId'];
  const payload: S2CPlayerMoved = {
    userId: player.userId,
    x: player.x,
    y: player.y,
    facing: player.facing,
    tickN: tick,
    equippedItemId: isDisguisedDoppel ? null : (equippedInst?.itemId ?? null),
    equippedItemBloody: !isDisguisedDoppel && equippedInst?.data?.['bloody'] === true,
    bloody: isDisguisedDoppel ? 0 : (player.bloody ?? 0),
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

/** True if `viewer` can perceive `target`. Ghost + invisable witch hidden. */
function canSee(viewer: PlayerInGame | null, target: PlayerInGame): boolean {
  // Witch invisablewalk: timed invisibility; only the witch herself sees.
  const invUntil = target.roleData?.['invisableUntilTick'] as number | undefined;
  if (target.roleId === 'witch' && invUntil !== undefined) {
    // Caller passes the current tick implicitly via global state — we
    // can't easily access it here, but the engine clears the flag once
    // expired. So while it's set, hide.
    if (!viewer) return false;
    if (viewer.userId === target.userId) return true;
    if (!viewer.isAlive || viewer.isWatching) return true;
    return false;
  }
  if (target.roleId !== 'ghost') return true;
  if (!viewer) return true;
  if (viewer.userId === target.userId) return true;
  if (!viewer.isAlive || viewer.isWatching) return true;
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
    victimDisplayName: victim.displayName,
    victimRealName: victim.realName,
    x: victim.x,
    y: victim.y,
  };
  dispatcher.broadcastMessage(OpCode.S2C_PLAYER_DIED, JSON.stringify(payload), null, null, true);
}

function broadcastCorpseUpdate(dispatcher: nkruntime.MatchDispatcher, c: Corpse): void {
  const pub: PublicCorpse = {
    corpseId: c.corpseId,
    victimUserId: c.victimUserId,
    victimDisplayName: c.victimDisplayName,
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

/**
 * After the end-of-round reveal screen, send everyone still connected back
 * to the same match's Lobby phase. Demographics (gender, hair, real name)
 * are kept so each player keeps their identity across rounds — only the
 * round-bound state (clock, players, containers, corpses, votes, etc.) is
 * cleared.
 */
function resetToLobby(
  state: PyrceMatchState,
  dispatcher: nkruntime.MatchDispatcher,
  logger: nkruntime.Logger,
): void {
  state.phase = MatchPhase.Lobby;
  state.gameModeId = null;
  state.players = {};
  state.groundItems = {};
  state.containers = {};
  state.corpses = {};
  state.clock = null;
  state.ended = false;
  delete state.endingResetAtTick;
  delete state.modeVotes;
  delete state.endGameVotes;
  delete state.kickVotes;
  delete state.scheduledDeaths;
  delete state.scheduledRevives;
  delete state.scheduledInfections;
  delete state.scheduledButterfly;
  delete state.searchRequests;
  delete state.pullingCorpse;
  delete state.koUntilTick;
  delete state.bleedUntilTick;
  delete state.frozenUntilTick;
  delete state.slowedUntilTick;
  delete state.washingUntilTick;
  delete state.sprinting;
  delete state.lastSprintDrainTick;
  delete state.lastShoveTick;
  delete state.lockedDoors;
  delete state.openDoors;
  delete state.pendingDoorCloses;
  delete state.doorCode;
  delete state.secretActualModeId;
  delete state.lightsOff;
  delete state.tapesDeleted;
  delete state.eyeOffers;
  delete state.scheduledEyeDeaths;
  broadcastPhaseChange(dispatcher, state);
  refreshLabel(dispatcher, state);
  broadcastLobbyState(dispatcher, state);
  logger.info('round end → lobby reset, presences=%d', countPresences(state));
}

/**
 * Snapshot the lobby roster (userId + displayName + isHost) and broadcast it
 * to everyone (or a single recipient if `to` is set). Cheap full-sync — the
 * lobby caps at MAX_PLAYERS and joins/leaves are infrequent.
 */
function broadcastLobbyState(
  dispatcher: nkruntime.MatchDispatcher,
  state: PyrceMatchState,
  to: nkruntime.Presence | null = null,
): void {
  if (state.phase !== MatchPhase.Lobby) return;
  const entries: S2CLobbyState['entries'] = [];
  for (const userId in state.presences) {
    const demo = state.lobbyDemographics[userId];
    if (!demo) continue;
    entries.push({
      userId,
      displayName: demo.displayName,
      isHost: userId === state.hostUserId,
    });
  }
  const payload: S2CLobbyState = { entries };
  dispatcher.broadcastMessage(
    OpCode.S2C_LOBBY_STATE,
    JSON.stringify(payload),
    to ? [to] : null,
    null,
    true,
  );
}

// ---------- helpers ----------

function withinPickupRange(player: PlayerInGame, x: number, y: number): boolean {
  // DM picks up only on-tile; we mirror that. Adjacent pickup is M3.x polish.
  return player.x === x && player.y === y;
}

/** True when any entry in a `{id: {x,y}}` map sits on (x, y). */
function entryAt<T extends { x: number; y: number }>(
  map: { [k: string]: T } | undefined,
  x: number,
  y: number,
): boolean {
  if (!map) return false;
  for (const k in map) {
    const e = map[k];
    if (e && e.x === x && e.y === y) return true;
  }
  return false;
}

/** Doors default to closed; only tiles flagged true in `openDoors` are passable. */
function closedDoorAt(state: PyrceMatchState, x: number, y: number): boolean {
  if (!tilemap.isDoor(x, y)) return false;
  return state.openDoors?.[`${x},${y}`] !== true;
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
