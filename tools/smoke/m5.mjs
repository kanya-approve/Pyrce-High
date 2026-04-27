// M5 end-to-end smoke: full Normal round.
//
//   1. Three clients (alice, bob, charlie) join + start Normal mode
//   2. Each receives S2C_PLAYER_ROLE_ASSIGNED — exactly one is killer
//   3. Killer's inventory has a knife pre-equipped (item-grant works)
//   4. Killer walks to civilians and kills them with the knife
//   5. S2C_GAME_RESULT fires with reason='last_faction_standing' or
//      'role_eliminated' and the killer in the winners list
//
// Run: pnpm -F @pyrce/smoke run m5

import { readFileSync } from 'node:fs';
import { Client } from '@heroiclabs/nakama-js';
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;

const TILEMAP = JSON.parse(
  readFileSync(
    new URL('../../packages/shared/src/content/tilemap/default.json', import.meta.url),
    'utf8',
  ),
);

const OP = {
  C2S_LOBBY_START_GAME: 1102,
  C2S_MOVE_INTENT: 1300,
  C2S_ATTACK: 1310,
  C2S_INV_EQUIP: 1402,
  S2C_PHASE_CHANGE: 2002,
  S2C_PLAYER_MOVED: 2310,
  S2C_PLAYER_HEALTH: 2311,
  S2C_PLAYER_DIED: 2317,
  S2C_PLAYER_ROLE_ASSIGNED: 2319,
  S2C_CLOCK_TICK: 2320,
  S2C_GAME_RESULT: 2321,
  S2C_INV_FULL: 2400,
  S2C_ANNOUNCEMENT: 2701,
};

const decode = (d) => (typeof d === 'string' ? d : new TextDecoder().decode(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function isPassable(x, y) {
  if (x < 0 || y < 0 || x >= TILEMAP.width || y >= TILEMAP.height) return false;
  const idx = TILEMAP.grid[y][x];
  const tt = TILEMAP.tileTypes[idx];
  return tt && tt.passable;
}

const DXS = [
  [0, -1, 'N'], [1, -1, 'NE'], [1, 0, 'E'], [1, 1, 'SE'],
  [0, 1, 'S'],  [-1, 1, 'SW'], [-1, 0, 'W'], [-1, -1, 'NW'],
];

function pathStep(start, target, acceptDist = 0, maxNodes = 5000) {
  if (chebyshev(start, target) <= acceptDist) return null;
  const startKey = `${start.x},${start.y}`;
  const visited = new Map();
  visited.set(startKey, { fromKey: null, dir: null });
  const queue = [start];
  let visitedCount = 0;
  while (queue.length > 0 && visitedCount < maxNodes) {
    const cur = queue.shift();
    visitedCount++;
    if (chebyshev(cur, target) <= acceptDist) {
      let key = `${cur.x},${cur.y}`;
      while (visited.get(key)?.fromKey !== startKey && visited.get(key)?.fromKey) {
        key = visited.get(key).fromKey;
      }
      return visited.get(key)?.dir ?? null;
    }
    for (const [dx, dy, dir] of DXS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const nkey = `${nx},${ny}`;
      if (visited.has(nkey)) continue;
      if (!isPassable(nx, ny)) continue;
      visited.set(nkey, { fromKey: `${cur.x},${cur.y}`, dir });
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
}

function inbox() {
  const events = [];
  const handlers = new Map();
  return {
    events,
    attach(socket) {
      socket.onmatchdata = (msg) => {
        const payload = JSON.parse(decode(msg.data));
        events.push({ op: msg.op_code, payload });
        const list = handlers.get(msg.op_code);
        if (list) for (const h of Array.from(list)) h(payload);
      };
    },
    on(op, cb) {
      let list = handlers.get(op);
      if (!list) { list = new Set(); handlers.set(op, list); }
      list.add(cb);
      return () => list.delete(cb);
    },
    onceOp(op) {
      return new Promise((resolve) => {
        const off = this.on(op, (p) => { off(); resolve(p); });
      });
    },
  };
}

async function main() {
  const make = async (deviceId) => {
    const client = new Client('defaultkey', '127.0.0.1', '7350', false);
    const session = await client.authenticateDevice(deviceId, true);
    const socket = client.createSocket(false, false);
    await socket.connect(session, true);
    return { client, session, socket };
  };

  console.log('1) Auth + create + join 3 clients');
  const A = await make('m5smoke-aaaaaaaaaaaaaaaaaaaaaaaa');
  const B = await make('m5smoke-bbbbbbbbbbbbbbbbbbbbbbbb');
  const C = await make('m5smoke-cccccccccccccccccccccccc');
  const aIn = inbox(); aIn.attach(A.socket);
  const bIn = inbox(); bIn.attach(B.socket);
  const cIn = inbox(); cIn.attach(C.socket);

  // Per-user position tracking from PLAYER_MOVED.
  const pos = {};
  for (const inb of [aIn, bIn, cIn]) {
    inb.on(OP.S2C_PLAYER_MOVED, (p) => { pos[p.userId] = { x: p.x, y: p.y }; });
  }

  const created = await A.client.rpc(A.session, 'createMatch', { name: 'M5 smoke' });
  const matchId = (typeof created.payload === 'string' ? JSON.parse(created.payload) : created.payload).matchId;
  await A.socket.joinMatch(matchId);
  await sleep(120);
  await B.socket.joinMatch(matchId);
  await sleep(120);
  await C.socket.joinMatch(matchId);

  console.log('2) Host (alice) starts the game');
  const phaseChange = aIn.onceOp(OP.S2C_PHASE_CHANGE);
  const aRole = aIn.onceOp(OP.S2C_PLAYER_ROLE_ASSIGNED);
  const bRole = bIn.onceOp(OP.S2C_PLAYER_ROLE_ASSIGNED);
  const cRole = cIn.onceOp(OP.S2C_PLAYER_ROLE_ASSIGNED);
  await A.socket.sendMatchState(matchId, OP.C2S_LOBBY_START_GAME, JSON.stringify({ gameModeId: 'normal' }));
  const phase = await phaseChange;
  console.log(`   phase=${phase.phase} mode=${phase.gameModeId} players=${phase.players.length}`);
  for (const p of phase.players) pos[p.userId] = { x: p.x, y: p.y };

  const aR = await aRole; const bR = await bRole; const cR = await cRole;
  const all = [
    { name: 'alice', s: A, role: aR, in: aIn },
    { name: 'bob',   s: B, role: bR, in: bIn },
    { name: 'char',  s: C, role: cR, in: cIn },
  ];
  for (const x of all) console.log(`   ${x.name} → ${x.role.roleId} (${x.role.roleName})`);
  const killers = all.filter(x => x.role.roleId === 'killer');
  if (killers.length !== 1) throw new Error(`expected exactly 1 killer, got ${killers.length}`);
  const killer = killers[0];
  const victims = all.filter(x => x.role.roleId !== 'killer');
  console.log(`   killer = ${killer.name}`);

  console.log('3) Killer should have a knife auto-equipped');
  // Wait briefly so any in-flight S2C_INV_FULL settles.
  await sleep(300);
  const allInvFulls = killer.in.events.filter(e => e.op === OP.S2C_INV_FULL);
  console.log(`   killer received ${allInvFulls.length} S2C_INV_FULL message(s)`);
  for (const ev of allInvFulls) console.log('   inv:', JSON.stringify(ev.payload));
  const killerInv = allInvFulls.pop()?.payload?.inventory;
  if (!killerInv) throw new Error('no S2C_INV_FULL for killer');
  const knife = killerInv.items.find(it => it.itemId === 'knife');
  if (!knife) throw new Error('killer has no knife');
  if (killerInv.equipped !== knife.instanceId) throw new Error('knife is not equipped');
  console.log(`   killer has knife ${knife.instanceId.slice(0,8)}, equipped=${killerInv.equipped === knife.instanceId}`);

  console.log('4) Verify clock ticks are firing');
  await sleep(1500);
  const lastClock = killer.in.events.filter(e => e.op === OP.S2C_CLOCK_TICK).pop()?.payload;
  if (!lastClock) throw new Error('no clock tick received in 1.5s');
  console.log(`   clock: ${lastClock.gameHour}:00 ${lastClock.ampm} (${lastClock.hoursLeft.toFixed(2)}h to dawn)`);

  console.log('5) Killer hunts victims — walk + attack each in turn');
  const gameResult = killer.in.onceOp(OP.S2C_GAME_RESULT);

  for (const v of victims) {
    if (!pos[v.s.session.user_id]) continue;
    console.log(`   walking to ${v.name} at ${JSON.stringify(pos[v.s.session.user_id])}`);
    let steps = 0;
    while (
      pos[killer.s.session.user_id] &&
      chebyshev(pos[killer.s.session.user_id], pos[v.s.session.user_id]) > 1 &&
      steps < 200
    ) {
      const dir = pathStep(pos[killer.s.session.user_id], pos[v.s.session.user_id], 1);
      if (!dir) break;
      await killer.s.socket.sendMatchState(matchId, OP.C2S_MOVE_INTENT, JSON.stringify({ dir }));
      await sleep(220);
      steps++;
    }
    if (chebyshev(pos[killer.s.session.user_id], pos[v.s.session.user_id]) > 1) {
      console.log(`   could not reach ${v.name}; bailing`);
      continue;
    }
    // Face victim
    const dx = Math.sign(pos[v.s.session.user_id].x - pos[killer.s.session.user_id].x);
    const dy = Math.sign(pos[v.s.session.user_id].y - pos[killer.s.session.user_id].y);
    const dirNames = { '-1,-1': 'NW', '0,-1': 'N', '1,-1': 'NE', '-1,0': 'W', '1,0': 'E', '-1,1': 'SW', '0,1': 'S', '1,1': 'SE' };
    const aimDir = dirNames[`${dx},${dy}`];
    let died = false;
    const offDeath = v.in.on(OP.S2C_PLAYER_DIED, (d) => { if (d.userId === v.s.session.user_id) died = true; });
    let swings = 0;
    while (!died && swings < 30) {
      await killer.s.socket.sendMatchState(matchId, OP.C2S_ATTACK, JSON.stringify({ dir: aimDir }));
      await sleep(800);
      swings++;
    }
    offDeath();
    console.log(`   ${v.name} ${died ? 'dead' : 'still alive'} after ${swings} swings`);
  }

  console.log('6) Wait for S2C_GAME_RESULT');
  const result = await Promise.race([gameResult, sleep(8000).then(() => null)]);
  if (!result) throw new Error('no game result within 8s after killing all victims');
  console.log(`   reason=${result.reason} summary="${result.summary}"`);
  console.log(`   winners: ${result.winners.map(w => `${w.username}(${w.roleId})`).join(', ')}`);
  console.log(`   reveals: ${result.reveals.map(r => `${r.username}=${r.roleId}${r.isAlive?'':'†'}`).join(', ')}`);
  if (!result.winners.find(w => w.userId === killer.s.session.user_id)) {
    throw new Error('killer did not win');
  }

  console.log('7) Cleanup');
  await A.socket.leaveMatch(matchId);
  await B.socket.leaveMatch(matchId);
  await C.socket.leaveMatch(matchId);
  A.socket.disconnect(true); B.socket.disconnect(true); C.socket.disconnect(true);

  console.log('PASS: M5 full Normal round end-to-end (role assignment + knife grant + clock + win condition)');
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
