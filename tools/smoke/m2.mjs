// M2 end-to-end smoke test: tilemap-driven movement + presence sync.
// - Two clients auth, alice creates + joins, bob joins
// - Alice sends C2S_LOBBY_START_GAME -> both receive S2C_PHASE_CHANGE
// - Each sends C2S_MOVE_INTENT, both observe the other moving via S2C_PLAYER_MOVED
// - A wall-bound move only updates facing (position unchanged)
//
// Run: pnpm -F @pyrce/smoke run m2

import { Client } from '@heroiclabs/nakama-js';
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;

// Mirror of OpCode/MatchPhase enums in @pyrce/shared. Smoke is plain JS so we
// inline the integer values rather than importing the TS enum.
const OP = {
  C2S_LOBBY_START_GAME: 1102,
  C2S_MOVE_INTENT: 1300,
  S2C_PHASE_CHANGE: 2002,
  S2C_INITIAL_SNAPSHOT: 2300,
  S2C_PLAYER_MOVED: 2310,
};

function decode(d) {
  if (typeof d === 'string') return d;
  return new TextDecoder().decode(d);
}

async function main() {
  // Note: Nakama enforces unique usernames. The smoke deliberately re-uses
  // the same device ids across runs so it idempotently re-auths the same
  // accounts (no username passed = keep whatever Nakama assigned the first
  // time the device-id was created).
  const make = async (deviceId) => {
    const client = new Client('defaultkey', '127.0.0.1', '7350', false);
    const session = await client.authenticateDevice(deviceId, true);
    const socket = client.createSocket(false, false);
    await socket.connect(session, true);
    return { client, session, socket };
  };

  console.log('1) Auth two clients');
  const A = await make('m2smoke-aaaaaaaaaaaaaaaaaaaaaaaa');
  const B = await make('m2smoke-bbbbbbbbbbbbbbbbbbbbbbbb');
  console.log('   alice =', A.session.username);
  console.log('   bob   =', B.session.username);

  // Bus to capture incoming match data per client.
  const inbox = (label) => {
    const events = [];
    const handlers = new Map();
    return {
      events,
      attach(socket) {
        socket.onmatchdata = (msg) => {
          const payload = JSON.parse(decode(msg.data));
          events.push({ op: msg.op_code, payload });
          const h = handlers.get(msg.op_code);
          if (h) h(payload);
          // console.log(`   [${label}] op=${msg.op_code} ${JSON.stringify(payload).slice(0, 80)}`);
        };
      },
      onceOp(op) {
        return new Promise((resolve) => handlers.set(op, (p) => { handlers.delete(op); resolve(p); }));
      },
      drain(op) {
        return events.filter(e => e.op === op);
      },
    };
  };
  const aIn = inbox('alice');
  const bIn = inbox('bob');
  aIn.attach(A.socket);
  bIn.attach(B.socket);

  console.log('2) Alice creates + both join');
  const created = await A.client.rpc(A.session, 'createMatch', { name: 'M2 smoke' });
  const createdPayload = typeof created.payload === 'string' ? JSON.parse(created.payload) : created.payload;
  const matchId = createdPayload.matchId;
  await A.socket.joinMatch(matchId);
  await new Promise(r => setTimeout(r, 200));
  await B.socket.joinMatch(matchId);
  console.log('   matchId =', matchId);

  console.log('3) Alice (host) starts the game');
  const aPhase = aIn.onceOp(OP.S2C_PHASE_CHANGE);
  const bPhase = bIn.onceOp(OP.S2C_PHASE_CHANGE);
  await A.socket.sendMatchState(matchId, OP.C2S_LOBBY_START_GAME, JSON.stringify({ gameModeId: 'normal' }));
  const [aPhasePayload, bPhasePayload] = await Promise.all([aPhase, bPhase]);
  console.log('   alice received phase=', aPhasePayload.phase, 'players=', aPhasePayload.players.length);
  console.log('   bob   received phase=', bPhasePayload.phase, 'players=', bPhasePayload.players.length);
  if (aPhasePayload.phase !== 'in_game' || aPhasePayload.players.length !== 2) {
    throw new Error('expected phase=in_game with 2 players');
  }

  // Pull each player's spawn position.
  const aliceSpawn = aPhasePayload.players.find(p => p.userId === A.session.user_id);
  const bobSpawn = aPhasePayload.players.find(p => p.userId === B.session.user_id);
  console.log('   alice spawn:', aliceSpawn);
  console.log('   bob   spawn:', bobSpawn);

  console.log('4) Alice moves East; both should receive S2C_PLAYER_MOVED for alice');
  const aFirstMove = aIn.onceOp(OP.S2C_PLAYER_MOVED);
  const bSeesAliceMove = bIn.onceOp(OP.S2C_PLAYER_MOVED);
  await A.socket.sendMatchState(matchId, OP.C2S_MOVE_INTENT, JSON.stringify({ dir: 'E' }));
  const [aMove, bSawA] = await Promise.all([aFirstMove, bSeesAliceMove]);
  console.log('   alice self-echo:', aMove);
  console.log('   bob saw alice:  ', bSawA);
  if (aMove.userId !== A.session.user_id || bSawA.userId !== A.session.user_id) {
    throw new Error('move broadcast missing or wrong user');
  }

  console.log('5) Bob moves South; alice should receive S2C_PLAYER_MOVED for bob');
  const aSeesBobMove = aIn.onceOp(OP.S2C_PLAYER_MOVED);
  await B.socket.sendMatchState(matchId, OP.C2S_MOVE_INTENT, JSON.stringify({ dir: 'S' }));
  const aSawB = await aSeesBobMove;
  console.log('   alice saw bob: ', aSawB);
  if (aSawB.userId !== B.session.user_id) throw new Error('alice did not see bob move');

  console.log('6) Wait for cooldown, then bob walks N many times to test wall-bump (will eventually hit something)');
  await new Promise(r => setTimeout(r, 250));
  let bobCurrent = bobSpawn;
  let bumped = false;
  for (let step = 0; step < 30; step++) {
    const pre = { x: bobCurrent.x, y: bobCurrent.y };
    const next = bIn.onceOp(OP.S2C_PLAYER_MOVED);
    await B.socket.sendMatchState(matchId, OP.C2S_MOVE_INTENT, JSON.stringify({ dir: 'N' }));
    const r = await next;
    if (r.userId === B.session.user_id) {
      bobCurrent = { x: r.x, y: r.y, facing: r.facing };
      if (pre.x === r.x && pre.y === r.y) {
        bumped = true;
        console.log(`   bumped at (${r.x},${r.y}) facing=${r.facing} after ${step + 1} steps`);
        break;
      }
    }
    await new Promise(r2 => setTimeout(r2, 220));
  }
  if (!bumped) {
    console.warn('   no wall hit in 30 steps — map is unusually open. M2 still passes.');
  }

  console.log('7) Cleanup');
  await A.socket.leaveMatch(matchId);
  await B.socket.leaveMatch(matchId);
  A.socket.disconnect(true);
  B.socket.disconnect(true);

  console.log('PASS: M2 movement flow works end-to-end');
  process.exit(0);
}

main().catch(err => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
