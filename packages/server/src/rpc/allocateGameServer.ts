/**
 * `allocateGameServer` RPC. Calls the Agones Allocator service
 * (https://agones.dev/site/docs/advanced/allocator-service/) with a
 * `GameServerAllocation` request and returns the address:port the client
 * should WebSocket to.
 *
 * Required env (set on the Nakama Deployment):
 *
 *   AGONES_ALLOCATOR_URL          https://agones-allocator.<ns>.svc:443
 *   AGONES_ALLOCATOR_NAMESPACE    e.g. "pyrce"
 *   AGONES_ALLOCATOR_FLEET        e.g. "pyrce"
 *   AGONES_ALLOCATOR_CLIENT_CERT  PEM, mounted from a Secret
 *   AGONES_ALLOCATOR_CLIENT_KEY   PEM, mounted from a Secret
 *   AGONES_ALLOCATOR_CA_CERT      PEM, the allocator's server CA
 *
 * The allocator endpoint is mTLS — Nakama mounts the client cert/key
 * from a K8s Secret and presents them on every call. In dev / when
 * `AGONES_ALLOCATOR_URL` is unset, the RPC returns a stub response so
 * the client flow still works without a real cluster.
 */

import type { AllocateGameServerRequest, AllocateGameServerResponse } from '@pyrce/shared';

interface AllocationResponse {
  gameServerName?: string;
  address?: string;
  ports?: Array<{ name?: string; port?: number }>;
}

export function allocateGameServerRpc(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string,
): string {
  let req: AllocateGameServerRequest = {};
  if (payload && payload.length > 0) {
    try {
      req = JSON.parse(payload) as AllocateGameServerRequest;
    } catch {
      throw newError('invalid_payload', 3);
    }
  }

  const env = ctx.env ?? {};
  const allocatorUrl = env['AGONES_ALLOCATOR_URL'];
  if (!allocatorUrl) {
    // Dev / single-machine fallback. The local docker-compose game-server
    // runs on AGONES_DISABLED=1 and listens on a static port.
    const stub: AllocateGameServerResponse = {
      gameServerName: 'pyrce-local',
      address: '127.0.0.1',
      port: 7777,
      allocatedAt: new Date().toISOString(),
    };
    logger.info('allocateGameServer: no AGONES_ALLOCATOR_URL set, returning local stub');
    return JSON.stringify(stub);
  }

  const namespace = env['AGONES_ALLOCATOR_NAMESPACE'] ?? 'pyrce';
  const fleet = env['AGONES_ALLOCATOR_FLEET'] ?? 'pyrce';

  const allocationBody = {
    namespace,
    gameServerSelectors: [
      {
        matchLabels: { 'agones.dev/fleet': fleet, game: 'pyrce' },
        gameServerState: 'Ready',
      },
    ],
    metadata: {
      labels: { 'pyrce-match': 'true' },
      annotations: {
        ...(req.matchId ? { 'pyrce-match-id': req.matchId } : {}),
        ...(req.region ? { 'pyrce-region': req.region } : {}),
        'pyrce-allocated-by': 'nakama',
      },
    },
  };

  // nk.httpRequest passes through to Nakama's runtime HTTP client. mTLS
  // certs come from the env vars; the Nakama runtime config wires
  // `runtime_environment.allocator_*` into env automatically.
  const res = nk.httpRequest(
    `${allocatorUrl}/gameserverallocation`,
    'post',
    { 'content-type': 'application/json' },
    JSON.stringify(allocationBody),
  );

  if (res.code !== 200) {
    logger.warn('allocator non-200: %d %s', res.code, res.body);
    throw newError('allocator_unavailable', 14);
  }
  let parsed: AllocationResponse;
  try {
    parsed = JSON.parse(res.body) as AllocationResponse;
  } catch {
    throw newError('allocator_invalid_response', 13);
  }

  const gamePort = parsed.ports?.find((p) => p.name === 'game')?.port ?? parsed.ports?.[0]?.port;
  if (!parsed.gameServerName || !parsed.address || !gamePort) {
    throw newError('allocator_incomplete', 13);
  }

  const out: AllocateGameServerResponse = {
    gameServerName: parsed.gameServerName,
    address: parsed.address,
    port: gamePort,
    allocatedAt: new Date().toISOString(),
  };
  logger.info(
    'allocateGameServer: %s @ %s:%d (matchId=%s)',
    out.gameServerName,
    out.address,
    out.port,
    req.matchId ?? '-',
  );
  return JSON.stringify(out);
}

function newError(message: string, code: number): nkruntime.Error {
  // Nakama's runtime expects this shape for thrown errors.
  return { message, code } as nkruntime.Error;
}
