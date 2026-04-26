// M1 end-to-end smoke test using two Nakama JS clients.
// Run with: node /tmp/m1-smoke.mjs
import { Client } from '@heroiclabs/nakama-js';

// node-fetch / WebSocket polyfills for nakama-js in Node 22+
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;

async function main() {
  const make = async (deviceId, username) => {
    const client = new Client('defaultkey', '127.0.0.1', '7350', false);
    const session = await client.authenticateDevice(deviceId, true, username);
    const socket = client.createSocket(false, false);
    await socket.connect(session, true);
    return { client, session, socket };
  };

  console.log('1) Auth two clients');
  const A = await make('m1smoke-aaaaaaaaaaaaaaaaaaaaaaaa', 'alice');
  const B = await make('m1smoke-bbbbbbbbbbbbbbbbbbbbbbbb', 'bob');
  console.log('   alice userId =', A.session.user_id);
  console.log('   bob   userId =', B.session.user_id);

  console.log('2) Alice creates a match');
  const created = await A.client.rpc(A.session, 'createMatch', { name: 'M1 smoke (alice)' });
  const createdPayload = typeof created.payload === 'string' ? JSON.parse(created.payload) : created.payload;
  console.log('   matchId =', createdPayload.matchId);
  console.log('   label   =', JSON.stringify(createdPayload.label));

  console.log('3) Alice joins her own match (socket)');
  const aMatch = await A.socket.joinMatch(createdPayload.matchId);
  console.log('   alice match keys:', Object.keys(aMatch));
  console.log('   alice presences after join:', (aMatch.presences ?? []).map(p => p.username));

  // Late-joiners see existing players via the initial joinMatch response's
  // `presences` array. Already-in-room players see the late-joiner via the
  // onmatchpresence event. We need to assert both directions of visibility,
  // not just both directions via events.
  let aliceSawBob = false;
  A.socket.onmatchpresence = (ev) => {
    for (const p of (ev.joins || [])) {
      console.log(`   [alice] saw join: ${p.username}`);
      if (p.username === 'bob') aliceSawBob = true;
    }
  };
  B.socket.onmatchpresence = (ev) => {
    for (const p of (ev.joins || [])) {
      console.log(`   [bob]   saw join: ${p.username}`);
    }
  };

  console.log('4) Wait 500ms for matchList index, then bob lists matches');
  await new Promise(r => setTimeout(r, 500));
  const listed = await B.client.rpc(B.session, 'listMatches', { limit: 20 });
  const listedPayload = typeof listed.payload === 'string' ? JSON.parse(listed.payload) : listed.payload;
  console.log('   visible matches:', listedPayload.matches.map(m => `${m.matchId} ${m.label.name} [${m.size}/22]`));
  console.log('   looking for:    ', createdPayload.matchId);
  // matchId format may differ between matchCreate (`uuid.node`) and matchList
  // (just `uuid`). Compare on the uuid prefix.
  const wantedId = createdPayload.matchId.split('.')[0];
  const target = listedPayload.matches.find(m => m.matchId.startsWith(wantedId));
  if (!target) throw new Error("alice's match not visible to bob");
  // Use whatever matchId form matchList returned for the join.
  createdPayload.matchId = target.matchId;

  console.log('5) Bob joins the match');
  const bMatch = await B.socket.joinMatch(target.matchId);
  console.log('   bob match keys:', Object.keys(bMatch));
  console.log('   bob presences after join:', (bMatch.presences ?? []).map(p => p.username));
  const bobSawAlice = (bMatch.presences ?? []).some(p => p.username === 'alice');

  console.log('6) Wait 1s for presence events to propagate…');
  await new Promise(r => setTimeout(r, 1000));

  console.log('7) Verify presence events delivered');
  console.log('   bob saw alice  =', bobSawAlice);
  console.log('   alice saw bob  =', aliceSawBob);

  console.log('8) Both leave the match');
  await A.socket.leaveMatch(createdPayload.matchId);
  await B.socket.leaveMatch(createdPayload.matchId);

  console.log('9) Disconnect');
  A.socket.disconnect(true);
  B.socket.disconnect(true);

  if (!bobSawAlice || !aliceSawBob) {
    console.error('FAIL: presence events not delivered both ways');
    process.exit(1);
  }
  console.log('PASS: M1 two-client lobby flow works end-to-end');
  process.exit(0);
}

main().catch(err => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
