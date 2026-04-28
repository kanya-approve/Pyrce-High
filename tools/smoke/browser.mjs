// Browser smoke: drive the actual client through Lobby → GameWorld and prove
// arrow keys cause C2S_MOVE_INTENT (opcode 1300) to be sent on the websocket.
//
// Prereq: dev server on http://localhost:8081, Nakama on :7350.
//
//   node tools/smoke/browser.mjs

import puppeteer from 'puppeteer';

const URL = process.argv[2] ?? 'http://localhost:8081/';

async function makePage(browser, name) {
  // Isolated context so each "tab" has its own localStorage (different
  // device-id → different Nakama user).
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || (msg.text().includes('[pyrce]') && !msg.text().includes('connected'))) {
      console.log(`[${name} ${t}]`, msg.text());
    }
  });
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));

  // Inject a websocket spy BEFORE the page scripts evaluate. Records every
  // outbound frame on a global so we can inspect later.
  await page.evaluateOnNewDocument(() => {
    const sent = [];
    window.__sentFrames = sent;
    const OrigWS = window.WebSocket;
    window.WebSocket = class extends OrigWS {
      send(data) {
        try {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          sent.push({ at: performance.now(), text });
        } catch (_) {}
        return super.send(data);
      }
    };
  });
  return page;
}

function decodeFrames(frames) {
  // Nakama JS SDK sends JSON envelopes. Parse out match data ones.
  return frames
    .map((f) => {
      try {
        return { at: f.at, msg: JSON.parse(f.text) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const A = await makePage(browser, 'A');
  const B = await makePage(browser, 'B');

  console.log('-> load both tabs');
  await A.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await B.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  // Wait for both to connect.
  await new Promise((r) => setTimeout(r, 1500));

  console.log('-> A creates a match');
  // The lobby browser scene listens for clicks on a "Create Match" Phaser button.
  // We don't easily know its coords; cheaper to drive it via the in-page Nakama
  // client we know exists on game.registry.
  const matchId = await A.evaluate(async () => {
    // Reach into Phaser's registry to grab the match client. main.ts stores it
    // there under 'match'.
    const game = window.__pyrceGame;
    if (!game) {
      // Find Phaser instance via the canvas; Phaser stores game on canvas.parentNode?.
      // Fall back: Phaser exposes via the `Phaser` global at runtime — but we
      // don't import it here. Instead use whatever the lobby browser does.
      throw new Error('no __pyrceGame global; need to expose game in main.ts');
    }
    const match = game.registry.get('match');
    const res = await match.client.rpc(match.session, 'createMatch', { name: 'browser-smoke' });
    const payload = typeof res.payload === 'string' ? JSON.parse(res.payload) : res.payload;
    return payload.matchId;
  }).catch((e) => {
    console.log('   (need to expose game for inspection — bailing on RPC path)', e.message);
    return null;
  });

  if (!matchId) {
    console.log('-> falling back to UI click flow');
    // Click "Create Match" on the lobby browser. The button text is 'Create Match'.
    const canvasBB = await A.evaluate(() => {
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height };
    });
    // Phaser renders the lobby — we can't easily click a Phaser text without
    // pixel positions. Instead we just send the Enter key (no — that opens chat).
    // The cleanest path is direct websocket: send C2S over the existing socket.
    // But the LobbyBrowser scene doesn't accept C2S; it uses RPCs.

    // Workaround: use page.evaluate to call match.client.rpc with the session.
    // We pulled the matchClient onto registry, but if __pyrceGame isn't exposed
    // we have no way to reach it. Let's expose it.
    await browser.close();
    console.log(
      '!!! main.ts needs window.__pyrceGame = game; for browser smoke. Patching and retrying.',
    );
    process.exit(2);
  }

  console.log(`-> match created: ${matchId}`);
  // Both tabs join.
  for (const [page, label] of [[A, 'A'], [B, 'B']]) {
    await page.evaluate(async (matchId) => {
      const game = window.__pyrceGame;
      const match = game.registry.get('match');
      await match.joinMatch(matchId);
    }, matchId);
    console.log(`   ${label} joined`);
  }
  await new Promise((r) => setTimeout(r, 600));

  console.log('-> drive both tabs into Lobby scene with the joined matchId');
  const aHostId = await A.evaluate(() => window.__pyrceGame.registry.get('match').userId);
  for (const [page, label] of [[A, 'A'], [B, 'B']]) {
    await page.evaluate(
      async (matchId, hostUserId) => {
        const game = window.__pyrceGame;
        game.scene.start('Lobby', { matchId, hostUserId });
      },
      matchId,
      aHostId,
    );
  }
  await new Promise((r) => setTimeout(r, 1200));
  // Verify Lobby scene is active before sending Start.
  const lobbyState = await A.evaluate(() => {
    const g = window.__pyrceGame;
    return g.scene.scenes.map((s) => ({ key: s.scene.key, active: s.scene.isActive() }));
  });
  console.log('   scene state pre-start:', lobbyState.filter((s) => s.active));

  console.log('-> A clicks Start');
  const startResult = await A.evaluate(async () => {
    const g = window.__pyrceGame;
    const match = g.registry.get('match');
    try {
      await match.sendMatch(1102, { gameModeId: 'normal' });
      return { ok: true, userId: match.userId };
    } catch (e) {
      return { ok: false, error: e.message ?? String(e) };
    }
  });
  console.log('   start result:', startResult);
  const sent = await A.evaluate(() => window.__sentFrames.map((f) => f.text));
  console.log(`   A sent ${sent.length} WS frames so far:`);
  for (const f of sent.slice(-5)) console.log('     ', f.slice(0, 200));
  // Wait for both pages to receive S2C_PHASE_CHANGE and transition to GameWorld.
  await new Promise((r) => setTimeout(r, 2500));

  // Reset frame logs to focus on movement.
  for (const p of [A, B]) await p.evaluate(() => (window.__sentFrames.length = 0));

  console.log('-> A presses ArrowDown 4 times');
  // Click canvas first to focus.
  const canvasBB = await A.evaluate(() => {
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await A.mouse.click(canvasBB.x, canvasBB.y);
  for (let i = 0; i < 4; i++) {
    await A.keyboard.press('ArrowDown');
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 400));

  // Inspect what Phaser sees.
  const sceneInfo = await A.evaluate(() => {
    const game = window.__pyrceGame;
    const scenes = game.scene.scenes.map((s) => ({
      key: s.scene.key,
      active: s.scene.isActive(),
      visible: s.scene.isVisible(),
    }));
    const gw = game.scene.getScene('GameWorld');
    const info = gw
      ? {
          hasKeyboard: !!gw.input?.keyboard,
          keyboardEnabled: gw.input?.keyboard?.enabled,
          cursorsExist: !!gw['cursors'],
          cursorsDownIsDown: gw['cursors']?.down?.isDown,
          activeElement: document.activeElement?.tagName + '#' + document.activeElement?.id,
        }
      : null;
    return { scenes, info };
  });
  console.log('   scene info:', JSON.stringify(sceneInfo, null, 2));

  // Inspect frames sent: we want C2S_MOVE_INTENT (1300).
  const frames = await A.evaluate(() => window.__sentFrames.map((f) => f.text));
  const matchData = frames.filter((t) => t.includes('"match_data_send"'));
  const moves = matchData.filter((t) => t.includes('"op_code":"1300"') || t.includes('op_code":1300'));
  console.log(`   matchData frames: ${matchData.length}, movement: ${moves.length}`);
  if (moves.length === 0) {
    console.log('   first 3 matchData frames:', matchData.slice(0, 3));
    console.log('   FAIL: no C2S_MOVE_INTENT was sent');
    await browser.close();
    process.exit(1);
  }

  console.log('-> sample move frame:', moves[0]);
  console.log('PASS: arrow keys produce C2S_MOVE_INTENT');

  console.log('-> chat: press T, type "wasd test", press Enter');
  // Reset frame log to focus on chat.
  await A.evaluate(() => (window.__sentFrames.length = 0));

  await A.keyboard.press('KeyT');
  await new Promise((r) => setTimeout(r, 200));

  // Verify chat input has focus.
  const focusState = await A.evaluate(() => ({
    activeTag: document.activeElement?.tagName,
    activeType: document.activeElement?.type,
    inputValue: document.activeElement?.value,
  }));
  console.log('   after T:', focusState);
  if (focusState.activeTag !== 'INPUT') {
    console.log('   FAIL: chat input did not gain focus on T');
    await browser.close();
    process.exit(1);
  }

  // Type a string that mixes letters bound to game keys.
  await A.keyboard.type('wasd efgci 12345');
  await new Promise((r) => setTimeout(r, 200));

  const typed = await A.evaluate(() => document.activeElement?.value);
  console.log(`   typed value: "${typed}"`);
  if (typed !== 'wasd efgci 12345') {
    console.log('   FAIL: chat input rejected/altered the keybind letters');
    await browser.close();
    process.exit(1);
  }

  await A.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 300));

  const chatFrames = await A.evaluate(() =>
    window.__sentFrames.map((f) => f.text).filter((t) => t.includes('"match_data_send"')),
  );
  const chatSent = chatFrames.find((t) => t.includes('"op_code":"1600"'));
  console.log(`   match_data frames after chat: ${chatFrames.length}`);
  if (!chatSent) {
    console.log('   FAIL: C2S_CHAT was not sent on Enter');
    await browser.close();
    process.exit(1);
  }
  console.log('PASS: chat typing accepts keybind letters and sends C2S_CHAT');

  // Verify no movement was triggered while typing in chat.
  const moveDuringChat = chatFrames.filter((t) => t.includes('"op_code":"1300"'));
  if (moveDuringChat.length > 0) {
    console.log('   FAIL: movement leaked through while chat was focused');
    await browser.close();
    process.exit(1);
  }
  console.log('PASS: no movement leaked while chat had focus');

  await browser.close();
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
