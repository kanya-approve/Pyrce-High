// M4 end-to-end smoke: combat + death + corpse + body discovery.
//
//   1. Three clients (alice, bob, charlie) join + start a match
//   2. Alice walks to a Knife_Rack and grabs a knife (lethal weapon)
//   3. Alice walks adjacent to bob and attacks until bob dies
//   4. Verify S2C_PLAYER_DIED + S2C_CORPSE_SPAWN broadcasts
//   5. Alice walks away; charlie walks adjacent to bob's corpse
//   6. Verify S2C_ANNOUNCEMENT (body discovered)
//
// Run: pnpm -F @pyrce/smoke run m4

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
  C2S_INV_PICKUP: 1400,
  C2S_INV_DROP: 1401,
  C2S_INV_EQUIP: 1402,
  C2S_INV_USE: 1404,
  C2S_CONTAINER_LOOK: 1500,
  C2S_CONTAINER_TAKE: 1501,
  S2C_PHASE_CHANGE: 2002,
  S2C_PLAYER_MOVED: 2310,
  S2C_PLAYER_HEALTH: 2311,
  S2C_PLAYER_DIED: 2317,
  S2C_CORPSE_SPAWN: 2330,
  S2C_INV_FULL: 2400,
  S2C_INV_DELTA: 2401,
  S2C_CONTAINER_CONTENTS: 2510,
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

/**
 * BFS pathfinder. Returns the next directional step toward the target
 * cell, or null if no path exists within `maxNodes`. Stops when within
 * `acceptDist` Chebyshev tiles of target (default 0 = exact).
 */
function pathStep(start, target, acceptDist = 0, maxNodes = 5000) {
  if (chebyshev(start, target) <= acceptDist) return null;
  const startKey = `${start.x},${start.y}`;
  const visited = new Map(); // key -> { fromKey, dir }
  visited.set(startKey, { fromKey: null, dir: null });
  const queue = [start];
  let visited_count = 0;
  while (queue.length > 0 && visited_count < maxNodes) {
    const cur = queue.shift();
    visited_count++;
    if (chebyshev(cur, target) <= acceptDist) {
      // Reconstruct first step
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

// Legacy greedy (kept for fallback) — used by the body-discovery test where
// players are already adjacent.
function stepTowards(player, target) {
  return pathStep(player, target, 1);
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

  console.log('1) Auth + create + join');
  const A = await make('m4smoke-aaaaaaaaaaaaaaaaaaaaaaaa');
  const B = await make('m4smoke-bbbbbbbbbbbbbbbbbbbbbbbb');
  const C = await make('m4smoke-cccccccccccccccccccccccc');
  const aIn = inbox(); aIn.attach(A.socket);
  const bIn = inbox(); bIn.attach(B.socket);
  const cIn = inbox(); cIn.attach(C.socket);

  // Track positions per user from PLAYER_MOVED.
  const pos = {};
  for (const inb of [aIn, bIn, cIn]) {
    inb.on(OP.S2C_PLAYER_MOVED, (p) => { pos[p.userId] = { x: p.x, y: p.y }; });
  }

  const created = await A.client.rpc(A.session, 'createMatch', { name: 'M4 smoke' });
  const matchId = (typeof created.payload === 'string' ? JSON.parse(created.payload) : created.payload).matchId;
  await A.socket.joinMatch(matchId);
  await sleep(120);
  await B.socket.joinMatch(matchId);
  await sleep(120);
  await C.socket.joinMatch(matchId);

  const phaseChange = aIn.onceOp(OP.S2C_PHASE_CHANGE);
  await A.socket.sendMatchState(matchId, OP.C2S_LOBBY_START_GAME, JSON.stringify({ gameModeId: 'normal' }));
  const phase = await phaseChange;
  for (const p of phase.players) pos[p.userId] = { x: p.x, y: p.y };
  console.log(`   phase=${phase.phase} players=${phase.players.length}`);
  console.log(`   positions: alice=${JSON.stringify(pos[A.session.user_id])} bob=${JSON.stringify(pos[B.session.user_id])} charlie=${JSON.stringify(pos[C.session.user_id])}`);

  console.log('2) Alice walks to the nearest Locker (some have knives in our LOOT)');
  const lockers = TILEMAP.containers
    .filter(c => /Locker/i.test(c.kind))
    .map(c => ({ ...c, dist: chebyshev(pos[A.session.user_id], c) }))
    .sort((x, y) => x.dist - y.dist);
  if (lockers.length === 0) throw new Error('no Locker on map');
  const knifeRack = lockers[0];
  console.log(`   target Locker at (${knifeRack.x},${knifeRack.y}) dist=${knifeRack.dist}`);

  let steps = 0;
  while (chebyshev(pos[A.session.user_id], knifeRack) > 1 && steps < 200) {
    const dir = pathStep(pos[A.session.user_id], knifeRack, 1);
    if (!dir) break;
    await A.socket.sendMatchState(matchId, OP.C2S_MOVE_INTENT, JSON.stringify({ dir }));
    await sleep(220);
    steps++;
  }
  console.log(`   reached (${pos[A.session.user_id].x},${pos[A.session.user_id].y}) in ${steps} steps (dist now ${chebyshev(pos[A.session.user_id], knifeRack)})`);

  console.log('3) Search lockers until we find any lethal weapon');
  let weaponInstance = null;
  let weaponContainer = null;
  for (let i = 0; i < Math.min(lockers.length, 12); i++) {
    const target = lockers[i];
    let steps = 0;
    while (chebyshev(pos[A.session.user_id], target) > 1 && steps < 150) {
      const dir = pathStep(pos[A.session.user_id], target, 1);
      if (!dir) break;
      await A.socket.sendMatchState(matchId, OP.C2S_MOVE_INTENT, JSON.stringify({ dir }));
      await sleep(220);
      steps++;
    }
    if (chebyshev(pos[A.session.user_id], target) > 1) continue;
    const lookRes = aIn.onceOp(OP.S2C_CONTAINER_CONTENTS);
    await A.socket.sendMatchState(matchId, OP.C2S_CONTAINER_LOOK, JSON.stringify({ x: target.x, y: target.y }));
    const contents = (await Promise.race([lookRes, sleep(2000).then(() => null)]))?.container;
    if (!contents) continue;
    const lethal = contents.contents.find(it => ['knife', 'metal_pipe', 'metal_bat'].includes(it.itemId));
    if (!lethal) continue;
    weaponInstance = lethal;
    weaponContainer = contents;
    console.log(`   found ${lethal.itemId} in locker ${i + 1} at (${target.x},${target.y})`);
    break;
  }
  if (!weaponInstance) throw new Error('no lethal weapon found in 12 lockers (RNG bad luck — re-run)');

  const takeDelta = aIn.onceOp(OP.S2C_INV_DELTA);
  await A.socket.sendMatchState(matchId, OP.C2S_CONTAINER_TAKE, JSON.stringify({ containerId: weaponContainer.containerId, instanceId: weaponInstance.instanceId }));
  const td = await takeDelta;
  console.log(`   took: ${td.upserted?.[0]?.itemId}`);

  console.log('4) Equip the knife');
  const equipDelta = aIn.onceOp(OP.S2C_INV_DELTA);
  await A.socket.sendMatchState(matchId, OP.C2S_INV_EQUIP, JSON.stringify({ instanceId: td.upserted[0].instanceId }));
  const ed = await equipDelta;
  console.log(`   equipped=${ed.equipped?.slice(0,8)}`);

  console.log('5) Walk to bob');
  steps = 0;
  while (chebyshev(pos[A.session.user_id], pos[B.session.user_id]) > 1 && steps < 200) {
    const dir = pathStep(pos[A.session.user_id], pos[B.session.user_id], 1);
    if (!dir) break;
    await A.socket.sendMatchState(matchId, OP.C2S_MOVE_INTENT, JSON.stringify({ dir }));
    await sleep(220);
    steps++;
  }
  console.log(`   alice now (${pos[A.session.user_id].x},${pos[A.session.user_id].y}) bob at (${pos[B.session.user_id].x},${pos[B.session.user_id].y})`);

  console.log('6) Attack bob until he dies');
  let bobDied = null;
  let corpse = null;
  bIn.on(OP.S2C_PLAYER_DIED, (d) => { if (d.userId === B.session.user_id) bobDied = d; });
  aIn.on(OP.S2C_CORPSE_SPAWN, (c) => { if (c.corpse.victimUserId === B.session.user_id) corpse = c.corpse; });

  // Face bob first.
  const dx = Math.sign(pos[B.session.user_id].x - pos[A.session.user_id].x);
  const dy = Math.sign(pos[B.session.user_id].y - pos[A.session.user_id].y);
  const dirNames = { '-1,-1': 'NW', '0,-1': 'N', '1,-1': 'NE', '-1,0': 'W', '1,0': 'E', '-1,1': 'SW', '0,1': 'S', '1,1': 'SE' };
  const aimDir = dirNames[`${dx},${dy}`];
  console.log(`   facing dir=${aimDir}`);

  let swings = 0;
  let bobHp = 100;
  while (!bobDied && swings < 50) {
    await A.socket.sendMatchState(matchId, OP.C2S_ATTACK, JSON.stringify({ dir: aimDir }));
    await sleep(800); // knife cooldown is ~700ms
    const lastHealth = aIn.events.filter(e => e.op === OP.S2C_PLAYER_HEALTH && e.payload.userId === B.session.user_id).pop();
    if (lastHealth) bobHp = lastHealth.payload.hp;
    swings++;
  }
  console.log(`   ${swings} swings, bobHp=${bobHp}, died=${bobDied ? 'yes' : 'no'}`);
  if (!bobDied) throw new Error('bob did not die in 50 swings');
  console.log(`   bob died: ${JSON.stringify(bobDied)}`);
  if (!corpse) throw new Error('no corpse spawned');
  console.log(`   corpse at (${corpse.x},${corpse.y}) discovered=${corpse.discovered}`);

  console.log('7) Alice walks away, charlie walks toward the corpse');
  // Alice steps away from corpse so the discovery isn't auto-blocked by killer-skip rule
  for (let s = 0; s < 5; s++) {
    const awayDir = aimDir.length === 2
      ? aimDir.split('').reverse().map(c => ({ N: 'S', S: 'N', E: 'W', W: 'E' }[c])).reverse().join('')
      : ({ N: 'S', S: 'N', E: 'W', W: 'E' }[aimDir]);
    await A.socket.sendMatchState(matchId, OP.C2S_MOVE_INTENT, JSON.stringify({ dir: awayDir }));
    await sleep(220);
  }
  console.log(`   alice now at (${pos[A.session.user_id].x},${pos[A.session.user_id].y})`);

  let announcement = null;
  cIn.on(OP.S2C_ANNOUNCEMENT, (a) => { if (a.kind === 'body_discovered') announcement = a; });

  steps = 0;
  while (chebyshev(pos[C.session.user_id], { x: corpse.x, y: corpse.y }) > 1 && steps < 200 && !announcement) {
    const dir = pathStep(pos[C.session.user_id], { x: corpse.x, y: corpse.y }, 1);
    if (!dir) break;
    await C.socket.sendMatchState(matchId, OP.C2S_MOVE_INTENT, JSON.stringify({ dir }));
    await sleep(220);
    steps++;
  }
  await sleep(500);
  console.log(`   charlie now (${pos[C.session.user_id].x},${pos[C.session.user_id].y}) after ${steps} steps`);
  if (!announcement) throw new Error('no body-discovered announcement received by charlie');
  console.log(`   announcement: "${announcement.message}"`);

  console.log('8) Cleanup');
  await A.socket.leaveMatch(matchId);
  await B.socket.leaveMatch(matchId);
  await C.socket.leaveMatch(matchId);
  A.socket.disconnect(true); B.socket.disconnect(true); C.socket.disconnect(true);

  console.log('PASS: M4 combat + death + corpse + body-discovery works end-to-end');
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
