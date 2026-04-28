// M7 fx-hooks smoke: verify the new server broadcasts actually fire.
//
//   1. Two clients join + start a normal-mode round.
//   2. Alice walks onto a known door tile → expect S2C_DOOR_STATE{open:true},
//      then a follow-up close ~3s later.
//   3. Alice picks up an item from a nearby container, equips it, and Bob
//      receives a S2C_PLAYER_MOVED with equippedItemId === the picked item.
//
// Smoke bombs aren't tested end-to-end here because no loot table currently
// drops them — the use-handler is wired but unreachable until a loot rule
// is added (or admin-injection arrives in a later milestone).
//
//   Run: node tools/smoke/m7.mjs

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
  C2S_INV_EQUIP: 1402,
  C2S_CONTAINER_LOOK: 1500,
  C2S_CONTAINER_TAKE: 1501,
  C2S_DOOR_TOGGLE: 1700,
  S2C_PHASE_CHANGE: 2002,
  S2C_PLAYER_MOVED: 2310,
  S2C_INV_FULL: 2400,
  S2C_INV_DELTA: 2401,
  S2C_WORLD_GROUND_ITEMS: 2500,
  S2C_CONTAINER_CONTENTS: 2510,
  S2C_DOOR_STATE: 2540,
};

const decode = (d) => (typeof d === 'string' ? d : new TextDecoder().decode(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function isPassable(x, y) {
  if (x < 0 || y < 0 || x >= TILEMAP.width || y >= TILEMAP.height) return false;
  const idx = TILEMAP.grid[y][x];
  return TILEMAP.tileTypes[idx]?.passable;
}

const DXS = [
  [0, -1, 'N'], [1, -1, 'NE'], [1, 0, 'E'], [1, 1, 'SE'],
  [0, 1, 'S'], [-1, 1, 'SW'], [-1, 0, 'W'], [-1, -1, 'NW'],
];

function pathStep(start, target, acceptDist = 0, maxNodes = 10000) {
  if (cheb(start, target) <= acceptDist) return null;
  const startKey = `${start.x},${start.y}`;
  const visited = new Map();
  visited.set(startKey, { fromKey: null, dir: null });
  const queue = [start];
  let n = 0;
  while (queue.length && n < maxNodes) {
    const cur = queue.shift();
    n++;
    if (cheb(cur, target) <= acceptDist) {
      let key = `${cur.x},${cur.y}`;
      while (visited.get(key)?.fromKey !== startKey && visited.get(key)?.fromKey) {
        key = visited.get(key).fromKey;
      }
      return visited.get(key)?.dir ?? null;
    }
    for (const [dx, dy, dir] of DXS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const nk = `${nx},${ny}`;
      if (visited.has(nk) || !isPassable(nx, ny)) continue;
      visited.set(nk, { fromKey: `${cur.x},${cur.y}`, dir });
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
    onceOp(op, predicate = () => true) {
      return new Promise((resolve) => {
        const off = this.on(op, (p) => {
          if (predicate(p)) { off(); resolve(p); }
        });
      });
    },
  };
}

async function walkTo(socket, matchId, pos, target, acceptDist = 0) {
  for (let i = 0; i < 250; i++) {
    if (cheb(pos.cur, target) <= acceptDist) return true;
    const dir = pathStep(pos.cur, target, acceptDist);
    if (!dir) return false;
    await socket.sendMatchState(matchId, OP.C2S_MOVE_INTENT, JSON.stringify({ dir }));
    await sleep(220);
  }
  return cheb(pos.cur, target) <= acceptDist;
}

async function main() {
  const make = async (deviceId) => {
    const client = new Client('defaultkey', '127.0.0.1', '7350', false);
    const session = await client.authenticateDevice(deviceId, true);
    const socket = client.createSocket(false, false);
    await socket.connect(session, true);
    return { client, session, socket };
  };

  console.log('1) Auth + create + start');
  const A = await make('m7smoke-aaaaaaaaaaaaaaaaaaaaaaaa');
  const B = await make('m7smoke-bbbbbbbbbbbbbbbbbbbbbbbb');
  const aIn = inbox(); aIn.attach(A.socket);
  const bIn = inbox(); bIn.attach(B.socket);

  // Track positions per user from S2C_PLAYER_MOVED.
  const posA = { cur: { x: 0, y: 0 } };
  const posB = { cur: { x: 0, y: 0 } };
  const userPos = {};
  for (const inb of [aIn, bIn]) {
    inb.on(OP.S2C_PLAYER_MOVED, (p) => {
      userPos[p.userId] = { x: p.x, y: p.y };
      if (p.userId === A.session.user_id) posA.cur = { x: p.x, y: p.y };
      if (p.userId === B.session.user_id) posB.cur = { x: p.x, y: p.y };
    });
  }

  const created = await A.client.rpc(A.session, 'createMatch', { name: 'M7 smoke' });
  const matchId = (typeof created.payload === 'string' ? JSON.parse(created.payload) : created.payload).matchId;
  await A.socket.joinMatch(matchId);
  await sleep(120);
  await B.socket.joinMatch(matchId);

  const phaseChange = aIn.onceOp(OP.S2C_PHASE_CHANGE);
  await A.socket.sendMatchState(matchId, OP.C2S_LOBBY_START_GAME, JSON.stringify({ gameModeId: 'normal' }));
  const phase = await phaseChange;
  for (const p of phase.players) {
    userPos[p.userId] = { x: p.x, y: p.y };
    if (p.userId === A.session.user_id) posA.cur = { x: p.x, y: p.y };
    if (p.userId === B.session.user_id) posB.cur = { x: p.x, y: p.y };
  }
  await sleep(200);
  console.log(`   alice=${JSON.stringify(posA.cur)} bob=${JSON.stringify(posB.cur)}`);

  // ----- 2) Door toggle -----
  console.log('2) Walk alice next to a door, send C2S_DOOR_TOGGLE, expect open then close');
  const doors = TILEMAP.doors.slice().sort(
    (a, b) => cheb(posA.cur, a) - cheb(posA.cur, b),
  );
  const door = doors[0];
  console.log(`   nearest door at (${door.x}, ${door.y}) dist=${cheb(posA.cur, door)}`);

  const reached = await walkTo(A.socket, matchId, posA, door, 1);
  if (!reached) throw new Error(`alice could not get adjacent to door`);

  const doorOpenP = aIn.onceOp(
    OP.S2C_DOOR_STATE,
    (p) => p.open === true && p.x === door.x && p.y === door.y,
  );
  await A.socket.sendMatchState(matchId, OP.C2S_DOOR_TOGGLE, JSON.stringify({ x: door.x, y: door.y }));
  const opened = await Promise.race([doorOpenP, sleep(2000).then(() => null)]);
  if (!opened) throw new Error('did not receive S2C_DOOR_STATE{open:true} after toggle');
  console.log(`   PASS door open broadcast received: ${JSON.stringify(opened)}`);

  // Toggle again to close.
  const doorCloseP = aIn.onceOp(
    OP.S2C_DOOR_STATE,
    (p) => p.open === false && p.x === door.x && p.y === door.y,
  );
  await A.socket.sendMatchState(matchId, OP.C2S_DOOR_TOGGLE, JSON.stringify({ x: door.x, y: door.y }));
  const closed = await Promise.race([doorCloseP, sleep(2000).then(() => null)]);
  if (!closed) throw new Error('did not receive S2C_DOOR_STATE{open:false} on second toggle');
  console.log(`   PASS door close broadcast received: ${JSON.stringify(closed)}`);

  // ----- 3) Equipped item visible to others -----
  console.log('3) Alice picks up something + equips, bob sees equippedItemId');
  // Walk alice next to a container that drops a knife (knife rack is rare).
  // Simpler: any container — try until inventory has something.
  const invItems = new Map(); // instanceId -> { itemId, ... }
  aIn.on(OP.S2C_INV_FULL, (p) => {
    invItems.clear();
    for (const it of p.items ?? []) invItems.set(it.instanceId, it);
  });
  aIn.on(OP.S2C_INV_DELTA, (p) => {
    for (const it of p.upserted ?? []) invItems.set(it.instanceId, it);
    for (const id of p.removed ?? []) invItems.delete(id);
  });

  // Walk to the closest container.
  const containers = TILEMAP.containers.slice().sort(
    (a, b) => cheb(posA.cur, a) - cheb(posA.cur, b),
  );
  let pickedUp = null;
  for (const c of containers.slice(0, 30)) {
    if (!await walkTo(A.socket, matchId, posA, c, 1)) continue;
    await A.socket.sendMatchState(matchId, OP.C2S_CONTAINER_LOOK, JSON.stringify({ x: c.x, y: c.y }));
    const contents = await Promise.race([
      aIn.onceOp(OP.S2C_CONTAINER_CONTENTS),
      sleep(800).then(() => null),
    ]);
    const ct = contents?.container;
    if (!ct || !ct.contents?.length) continue;
    const target = ct.contents[0];
    await A.socket.sendMatchState(
      matchId,
      OP.C2S_CONTAINER_TAKE,
      JSON.stringify({ containerId: ct.containerId, instanceId: target.instanceId }),
    );
    await sleep(400);
    if (invItems.size > 0) { pickedUp = [...invItems.values()][0]; break; }
  }
  if (!pickedUp) throw new Error('failed to acquire any item to equip');
  console.log(`   acquired ${pickedUp.itemId} (instanceId=${pickedUp.instanceId})`);

  const moveWithEquip = bIn.onceOp(
    OP.S2C_PLAYER_MOVED,
    (p) => p.userId === A.session.user_id && p.equippedItemId === pickedUp.itemId,
  );
  await A.socket.sendMatchState(
    matchId,
    OP.C2S_INV_EQUIP,
    JSON.stringify({ instanceId: pickedUp.instanceId }),
  );
  const move = await Promise.race([moveWithEquip, sleep(2000).then(() => null)]);
  if (!move) throw new Error('bob did not receive S2C_PLAYER_MOVED with equippedItemId');
  console.log(`   PASS bob saw alice equip ${move.equippedItemId}`);

  console.log('PASS: M7 fx hooks (door state + equipped item) work end-to-end');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
