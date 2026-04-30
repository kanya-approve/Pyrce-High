/**
 * Pyrce High — Agones-managed dedicated game-server.
 *
 * Architecture (per Heroic Labs guidance for Nakama + dedicated fleets):
 *   - Nakama runs as the matchmaker / identity / social backplane.
 *   - When a match is found, Nakama calls the Agones Allocator API
 *     (see `packages/server/src/rpc/allocateGameServer.ts`) which picks a
 *     Ready GameServer from the Pyrce Fleet and flips it to Allocated.
 *   - Nakama broadcasts the allocated GameServer's `address:port` to the
 *     matched players over `S2C_GAME_SERVER_ASSIGNED`.
 *   - Players connect a WebSocket directly to *this* binary, which runs
 *     the realtime round (movement, combat, lighting, …) and reports the
 *     final result back to Nakama via the server-to-server HTTP API.
 *
 * Lifecycle hooks the SDK gives us:
 *
 *   connect()                — handshake with the local sidecar gRPC server
 *   ready()                  — flip GameServer state to Ready (allocatable)
 *   health()                 — heartbeat; missing several in a row → reap
 *   watchGameServer(cb)      — observe state transitions (Allocated, Shutdown, …)
 *   allocate() / reserve()   — usually triggered externally; we just react
 *   setLabel()/setAnnotation — surface custom state to the Allocator
 *   shutdown()               — graceful exit; pod gets cleaned up
 *
 * Configured via env (defaults match the bundled `infra/k8s/agones/`
 * GameServer manifest):
 *
 *   GAME_PORT             tcp port we listen on (matches Agones containerPort)
 *   AGONES_DISABLED       run without the SDK (local dev w/o Agones)
 *   HEALTH_INTERVAL_MS    default 2000 (Agones default is health every <5s)
 *   ROUND_TIMEOUT_S       hard ceiling — if no players connect or the round
 *                         never resolves we Shutdown() ourselves to free
 *                         the pod for the next allocation.
 */

import { createServer } from 'node:http';
import { AgonesSDK } from '@google-cloud/agones-sdk';
import { type WebSocket, WebSocketServer } from 'ws';

const GAME_PORT = Number(process.env['GAME_PORT'] ?? 7777);
const AGONES_DISABLED = process.env['AGONES_DISABLED'] === '1';
const HEALTH_INTERVAL_MS = Number(process.env['HEALTH_INTERVAL_MS'] ?? 2000);
const ROUND_TIMEOUT_S = Number(process.env['ROUND_TIMEOUT_S'] ?? 30 * 60);

interface Logger {
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}
const log: Logger = (() => {
  function emit(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: 'game-server',
      msg,
      ...(extra ? { extra } : {}),
    });
    if (level === 'error') console.error(line);
    else console.log(line);
  }
  return {
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
  };
})();

interface ConnectedPlayer {
  socket: WebSocket;
  playerId?: string;
  joinedAt: number;
}

const players = new Map<WebSocket, ConnectedPlayer>();
let allocated = false;
let agonesSDK: AgonesSDK | null = null;
let healthTimer: NodeJS.Timeout | null = null;

function startWebSocketListener(): WebSocketServer {
  // The HTTP server lets us add a tiny `/healthz` for liveness probes; the
  // ws server upgrades on the same port for game traffic.
  const http = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (socket, req) => {
    const player: ConnectedPlayer = { socket, joinedAt: Date.now() };
    players.set(socket, player);
    log.info('player connected', { remote: req.socket.remoteAddress, count: players.size });
    socket.on('message', (raw) => handleMessage(player, raw));
    socket.on('close', () => {
      players.delete(socket);
      log.info('player disconnected', { count: players.size });
      checkRoundEnd();
    });
    socket.on('error', (err) => log.warn('socket error', { err: String(err) }));
  });

  http.listen(GAME_PORT, () => log.info('listening', { port: GAME_PORT }));
  return wss;
}

/**
 * Placeholder for the real match handler. Today the round logic still
 * lives in the Nakama match handler at packages/server/src/matches/
 * pyrceRoom.ts; migrating it to this binary is the v1.x project this
 * package was set up to enable. For now we accept connections, echo a
 * "match in progress" frame, and wait for either everyone to leave or
 * the round-timeout to elapse.
 */
function handleMessage(player: ConnectedPlayer, raw: import('ws').RawData): void {
  let msg: unknown;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (typeof msg === 'object' && msg !== null && 'hello' in msg) {
    const m = msg as { hello?: { playerId?: string } };
    if (m.hello?.playerId) player.playerId = m.hello.playerId;
    player.socket.send(JSON.stringify({ ack: true, playerId: player.playerId }));
  }
}

function checkRoundEnd(): void {
  if (!allocated) return;
  if (players.size > 0) return;
  log.info('all players disconnected — ending round');
  void shutdownGameServer('round-empty');
}

async function shutdownGameServer(reason: string): Promise<void> {
  log.info('shutting down', { reason });
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  for (const p of players.values()) {
    try {
      p.socket.close(1000, 'round ended');
    } catch {}
  }
  if (agonesSDK) {
    try {
      await agonesSDK.shutdown();
    } catch (e) {
      log.warn('Agones shutdown call failed', { err: String(e) });
    }
  }
  process.exit(0);
}

async function bootAgones(): Promise<void> {
  if (AGONES_DISABLED) {
    log.warn('AGONES_DISABLED=1 — running without SDK (local dev only)');
    return;
  }
  agonesSDK = new AgonesSDK();
  log.info('connecting to Agones SDK', { port: agonesSDK.port });
  await agonesSDK.connect();

  agonesSDK.watchGameServer(
    (gs) => {
      const state = gs.status?.state;
      log.info('GameServer state', {
        name: gs.objectMeta?.name,
        state,
        address: gs.status?.address,
      });
      if (state === 'Allocated' && !allocated) {
        allocated = true;
        log.info('round started — players will connect');
        // Hard ceiling so a stuck round eventually frees the pod.
        setTimeout(() => {
          if (allocated) void shutdownGameServer('round-timeout');
        }, ROUND_TIMEOUT_S * 1000);
      }
      if (state === 'Shutdown') {
        void shutdownGameServer('agones-shutdown');
      }
    },
    (err) => log.warn('watchGameServer error', { err: String(err) }),
  );

  // Surface the build version + capacity to the Allocator via labels.
  await agonesSDK.setLabel('game', 'pyrce');
  await agonesSDK.setLabel('build', process.env['BUILD_SHA'] ?? 'dev');

  await agonesSDK.ready();
  log.info('Ready — Agones can allocate this GameServer');

  healthTimer = setInterval(() => {
    agonesSDK?.health((err) => log.warn('health() error', { err: String(err) }));
  }, HEALTH_INTERVAL_MS);
}

async function main(): Promise<void> {
  startWebSocketListener();
  await bootAgones();

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      log.info(`${sig} received`);
      void shutdownGameServer(sig);
    });
  }
}

main().catch((e) => {
  log.error('fatal', { err: e instanceof Error ? e.stack : String(e) });
  process.exit(1);
});
