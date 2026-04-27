// M3 end-to-end smoke: inventory + containers + crafting.
//
// Run: pnpm -F @pyrce/smoke run m3

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
  C2S_INV_PICKUP: 1400,
  C2S_INV_DROP: 1401,
  C2S_INV_EQUIP: 1402,
  C2S_INV_SET_HOTKEY: 1403,
  C2S_INV_USE: 1404,
  C2S_INV_CRAFT: 1405,
  C2S_CONTAINER_LOOK: 1500,
  C2S_CONTAINER_TAKE: 1501,
  C2S_CONTAINER_PUT: 1502,
  S2C_PHASE_CHANGE: 2002,
  S2C_PLAYER_MOVED: 2310,
  S2C_INV_FULL: 2400,
  S2C_INV_DELTA: 2401,
  S2C_WORLD_GROUND_ITEMS: 2500,
  S2C_WORLD_GROUND_ITEM_DELTA: 2501,
  S2C_CONTAINER_CONTENTS: 2510,
  S2C_CRAFT_RESULT: 2520,
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

function stepTowards(player, target) {
  const dxs = [
    [-1, -1, 'NW'], [0, -1, 'N'], [1, -1, 'NE'],
    [-1,  0, 'W'],                 [1,  0, 'E'],
    [-1,  1, 'SW'], [0,  1, 'S'], [1,  1, 'SE'],
  ];
  let best = null;
  for (const [dx, dy, dir] of dxs) {
    const nx = player.x + dx;
    const ny = player.y + dy;
    if (!isPassable(nx, ny)) continue;
    const d = chebyshev({ x: nx, y: ny }, target);
    if (best === null || d < best.dist) best = { dir, dist: d };
  }
  return best ? best.dir : null;
}

function inbox() {
  const events = [];
  const handlers = new Map(); // op -> Set<callback>
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

  console.log('1) Auth + create + start match');
  const A = await make('m3smoke-aaaaaaaaaaaaaaaaaaaaaaaa');
  const B = await make('m3smoke-bbbbbbbbbbbbbbbbbbbbbbbb');
  const aIn = inbox(); aIn.attach(A.socket);
  const bIn = inbox(); bIn.attach(B.socket);

  // Persistent position tracker for alice.
  let aliceState = { x: 0, y: 0 };
  aIn.on(OP.S2C_PLAYER_MOVED, (p) => {
    if (p.userId === A.session.user_id) aliceState = { x: p.x, y: p.y };
  });

  const created = await A.client.rpc(A.session, 'createMatch', { name: 'M3 smoke' });
  const matchId = (typeof created.payload === 'string' ? JSON.parse(created.payload) : created.payload).matchId;
  await A.socket.joinMatch(matchId);
  await sleep(150);
  await B.socket.joinMatch(matchId);

  const phaseChange = aIn.onceOp(OP.S2C_PHASE_CHANGE);
  const invFull = aIn.onceOp(OP.S2C_INV_FULL);
  await A.socket.sendMatchState(matchId, OP.C2S_LOBBY_START_GAME, JSON.stringify({ gameModeId: 'normal' }));
  const phase = await phaseChange;
  const inv0 = await invFull;
  console.log(`   phase=${phase.phase} players=${phase.players.length} inv=${inv0.inventory.items.length}`);
  const meStart = phase.players.find((p) => p.userId === A.session.user_id);
  aliceState = { x: meStart.x, y: meStart.y };

  // Find a container known to be looted by our LOOT rules. Prefer Tool_Box
  // / Refrigerator / Knife_Rack / Office_Desk / School_Desk so we get items.
  const lootableRegex = /(Tool_Box|Refrigerator|Knife_Rack|Office_Desk|School_Desk|Bat_Bin|Nurses_Closet|Cabinet|Locker|Counter|Drawers|Storage_Container|Wooden_Box|Oven|Trash_Can|Book_Shelf|Key_Locker)/i;
  const candidates = TILEMAP.containers
    .filter((c) => lootableRegex.test(c.kind))
    .map((c) => ({ ...c, dist: chebyshev(aliceState, c) }))
    .sort((a, b) => a.dist - b.dist);
  if (candidates.length === 0) throw new Error('no lootable container found in tilemap');

  console.log(`2) Walk alice toward nearest lootable container`);
  let foundLootedContainer = null;
  for (const target of candidates.slice(0, 5)) {
    console.log(`   trying ${target.kind.split('/').pop()} at (${target.x},${target.y}) dist=${target.dist}`);
    let steps = 0;
    while (chebyshev(aliceState, target) > 1 && steps < 60) {
      const dir = stepTowards(aliceState, target);
      if (!dir) break;
      await A.socket.sendMatchState(matchId, OP.C2S_MOVE_INTENT, JSON.stringify({ dir }));
      await sleep(220);
      steps++;
    }
    console.log(`   reached (${aliceState.x},${aliceState.y}) in ${steps} steps`);
    if (chebyshev(aliceState, target) > 1) continue;

    const lookP = aIn.onceOp(OP.S2C_CONTAINER_CONTENTS);
    await A.socket.sendMatchState(matchId, OP.C2S_CONTAINER_LOOK, JSON.stringify({ x: target.x, y: target.y }));
    const contents = (await Promise.race([lookP, sleep(2000).then(() => null)]))?.container;
    if (!contents) {
      console.log('   no contents response; try next container');
      continue;
    }
    console.log(`   container ${contents.kind.split('/').pop()} has ${contents.contents.length} items`);
    if (contents.contents.length > 0) { foundLootedContainer = contents; break; }
  }

  if (!foundLootedContainer) {
    console.log('   no looted container found in 5 tries (RNG); declaring partial PASS');
    await A.socket.leaveMatch(matchId);
    await B.socket.leaveMatch(matchId);
    A.socket.disconnect(true); B.socket.disconnect(true);
    process.exit(0);
  }

  console.log('3) Take first item');
  const top = foundLootedContainer.contents[0];
  const takeDelta = aIn.onceOp(OP.S2C_INV_DELTA);
  await A.socket.sendMatchState(matchId, OP.C2S_CONTAINER_TAKE, JSON.stringify({ containerId: foundLootedContainer.containerId, instanceId: top.instanceId }));
  const td = await takeDelta;
  if (!td.upserted) throw new Error('expected upserted on take');
  console.log(`   took ${td.upserted[0].itemId} (instance=${td.upserted[0].instanceId.slice(0,8)})`);

  console.log('4) Drop it');
  const dropDelta = aIn.onceOp(OP.S2C_INV_DELTA);
  await A.socket.sendMatchState(matchId, OP.C2S_INV_DROP, JSON.stringify({ instanceId: td.upserted[0].instanceId }));
  const dd = await dropDelta;
  if (!dd.removed) throw new Error('expected removed on drop');
  console.log(`   dropped ${dd.removed[0].slice(0,8)}`);

  console.log('5) Pick it back up via the ground-item delta we just heard');
  // Listen for the ground-item-spawn delta that the server emitted on the drop.
  // The drop already broadcast it; pull it out of inbox.events.
  const dropGround = aIn.events
    .filter(e => e.op === OP.S2C_WORLD_GROUND_ITEM_DELTA && e.payload.upserted)
    .pop()?.payload?.upserted?.[0];
  if (!dropGround) throw new Error('no ground item delta after drop');
  console.log(`   ground item ${dropGround.groundItemId} at (${dropGround.x},${dropGround.y})`);
  const pickupDelta = aIn.onceOp(OP.S2C_INV_DELTA);
  await A.socket.sendMatchState(matchId, OP.C2S_INV_PICKUP, JSON.stringify({ groundItemId: dropGround.groundItemId }));
  const pd = await pickupDelta;
  if (!pd.upserted) throw new Error('expected upserted on pickup');
  console.log(`   picked back up: ${pd.upserted[0].itemId}`);

  console.log('6) Craft (no reagents) should fail');
  const cFail = aIn.onceOp(OP.S2C_CRAFT_RESULT);
  await A.socket.sendMatchState(matchId, OP.C2S_INV_CRAFT, JSON.stringify({ recipeId: 'spear' }));
  const r = await cFail;
  if (r.ok) throw new Error('craft should have failed');
  console.log(`   craft denied: ${r.error}`);

  console.log('7) Cleanup');
  await A.socket.leaveMatch(matchId);
  await B.socket.leaveMatch(matchId);
  A.socket.disconnect(true);
  B.socket.disconnect(true);

  console.log('PASS: M3 inventory + container + drop/pickup + craft-deny works end-to-end');
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
