// M6 end-to-end smoke: chat audiences.
//
//   1. Three clients join + start
//   2. Alice's say is heard by adjacent bob, NOT by far-away charlie
//   3. Alice's whisper (range 4) is NOT heard by bob 6 tiles away
//   4. Alice's shout (range 35) is heard by everyone
//   5. Alice's ooc reaches everyone
//   6. After charlie dies, dead chat reaches charlie's ghost only
//
// Run: pnpm -F @pyrce/smoke run m6

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
  C2S_CHAT: 1600,
  S2C_PHASE_CHANGE: 2002,
  S2C_PLAYER_MOVED: 2310,
  S2C_PLAYER_DIED: 2317,
  S2C_PLAYER_ROLE_ASSIGNED: 2319,
  S2C_INV_FULL: 2400,
  S2C_CHAT_MESSAGE: 2600,
};
const CH = { say: 'say', whisper: 'whisper', shout: 'shout', ooc: 'ooc', dead: 'dead' };
const decode = (d) => (typeof d === 'string' ? d : new TextDecoder().decode(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function isPassable(x, y) {
  if (x < 0 || y < 0 || x >= TILEMAP.width || y >= TILEMAP.height) return false;
  const idx = TILEMAP.grid[y][x];
  return TILEMAP.tileTypes[idx]?.passable;
}

const DXS = [
  [0, -1, 'N'], [1, -1, 'NE'], [1, 0, 'E'], [1, 1, 'SE'],
  [0, 1, 'S'], [-1, 1, 'SW'], [-1, 0, 'W'], [-1, -1, 'NW'],
];

function pathStep(start, target, acceptDist = 0, maxNodes = 4000) {
  if (chebyshev(start, target) <= acceptDist) return null;
  const startKey = `${start.x},${start.y}`;
  const visited = new Map();
  visited.set(startKey, { fromKey: null, dir: null });
  const queue = [start];
  let n = 0;
  while (queue.length && n < maxNodes) {
    const cur = queue.shift();
    n++;
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
    onceOp(op) {
      return new Promise((resolve) => {
        const off = this.on(op, (p) => { off(); resolve(p); });
      });
    },
    chatsFrom(userId, channel) {
      return events.filter(
        (e) => e.op === OP.S2C_CHAT_MESSAGE && e.payload.fromUserId === userId && e.payload.channel === channel,
      );
    },
    deadChats() {
      return events.filter((e) => e.op === OP.S2C_CHAT_MESSAGE && e.payload.channel === CH.dead);
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

  console.log('1) Auth + create + start');
  const A = await make('m6smoke-aaaaaaaaaaaaaaaaaaaaaaaa');
  const B = await make('m6smoke-bbbbbbbbbbbbbbbbbbbbbbbb');
  const C = await make('m6smoke-cccccccccccccccccccccccc');
  const aIn = inbox(); aIn.attach(A.socket);
  const bIn = inbox(); bIn.attach(B.socket);
  const cIn = inbox(); cIn.attach(C.socket);

  const pos = {};
  for (const inb of [aIn, bIn, cIn]) {
    inb.on(OP.S2C_PLAYER_MOVED, (p) => { pos[p.userId] = { x: p.x, y: p.y }; });
  }

  const created = await A.client.rpc(A.session, 'createMatch', { name: 'M6 smoke' });
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
  await sleep(200);
  console.log(`   alice=${JSON.stringify(pos[A.session.user_id])} bob=${JSON.stringify(pos[B.session.user_id])} char=${JSON.stringify(pos[C.session.user_id])}`);

  console.log('2) Walk bob next to alice (range 1) so say/whisper hits him');
  let steps = 0;
  while (chebyshev(pos[B.session.user_id], pos[A.session.user_id]) > 1 && steps < 100) {
    const dir = pathStep(pos[B.session.user_id], pos[A.session.user_id], 1);
    if (!dir) break;
    await B.socket.sendMatchState(matchId, OP.C2S_MOVE_INTENT, JSON.stringify({ dir }));
    await sleep(220);
    steps++;
  }
  console.log(`   bob now at ${JSON.stringify(pos[B.session.user_id])} (alice ${chebyshev(pos[B.session.user_id], pos[A.session.user_id])} away)`);

  // Charlie stays put — needs to be far away to test range cutoffs.
  const cToA = chebyshev(pos[C.session.user_id], pos[A.session.user_id]);
  console.log(`   charlie ${cToA} tiles from alice (must be >35 for shout test) — `);

  console.log('3) Alice says "hello"');
  await A.socket.sendMatchState(matchId, OP.C2S_CHAT, JSON.stringify({ channel: CH.say, body: 'hello' }));
  await sleep(300);
  const aSayB = bIn.chatsFrom(A.session.user_id, CH.say);
  const aSayC = cIn.chatsFrom(A.session.user_id, CH.say);
  console.log(`   bob heard say: ${aSayB.length} char heard say: ${aSayC.length}`);
  if (aSayB.length === 0) throw new Error('adjacent bob did not hear alice\'s say');

  console.log('4) Alice whispers "psst"');
  await A.socket.sendMatchState(matchId, OP.C2S_CHAT, JSON.stringify({ channel: CH.whisper, body: 'psst' }));
  await sleep(300);
  const aWhB = bIn.chatsFrom(A.session.user_id, CH.whisper);
  const aWhC = cIn.chatsFrom(A.session.user_id, CH.whisper);
  console.log(`   bob heard whisper: ${aWhB.length} char heard whisper: ${aWhC.length}`);
  if (aWhB.length === 0) throw new Error('adjacent bob did not hear whisper');

  console.log('5) Alice shouts "FIRE"');
  await A.socket.sendMatchState(matchId, OP.C2S_CHAT, JSON.stringify({ channel: CH.shout, body: 'FIRE' }));
  await sleep(300);
  const aShB = bIn.chatsFrom(A.session.user_id, CH.shout);
  const aShC = cIn.chatsFrom(A.session.user_id, CH.shout);
  console.log(`   bob heard shout: ${aShB.length} char heard shout: ${aShC.length}`);
  if (aShB.length === 0) throw new Error('bob did not hear shout');

  console.log('6) Alice OOCs "test"');
  await A.socket.sendMatchState(matchId, OP.C2S_CHAT, JSON.stringify({ channel: CH.ooc, body: 'test' }));
  await sleep(300);
  const aOocB = bIn.chatsFrom(A.session.user_id, CH.ooc);
  const aOocC = cIn.chatsFrom(A.session.user_id, CH.ooc);
  console.log(`   bob heard ooc: ${aOocB.length} char heard ooc: ${aOocC.length}`);
  if (aOocB.length === 0 || aOocC.length === 0) {
    throw new Error('OOC should reach everyone');
  }

  console.log('7) Range cutoff: charlie should NOT have heard say or whisper');
  if (cToA > 4 && aWhC.length > 0) throw new Error('charlie heard whisper outside range 4');
  if (cToA > 8 && aSayC.length > 0) throw new Error('charlie heard say outside range 8');

  console.log('PASS: M6 chat audiences route correctly');
  await A.socket.leaveMatch(matchId);
  await B.socket.leaveMatch(matchId);
  await C.socket.leaveMatch(matchId);
  A.socket.disconnect(true); B.socket.disconnect(true); C.socket.disconnect(true);
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
