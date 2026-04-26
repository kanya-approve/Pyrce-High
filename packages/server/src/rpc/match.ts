import {
  type CreateMatchRequest,
  type CreateMatchResponse,
  type ListMatchesRequest,
  type ListMatchesResponse,
  type MatchLabel,
  type MatchListing,
  WIRE_PROTOCOL_VERSION,
} from '@pyrce/shared';
import { MATCH_NAME } from '../matches/pyrceRoom.js';
import { MAX_PLAYERS } from '../matches/state.js';

/**
 * Host creates a new pyrce_room. The host's userId is baked into matchInit
 * params so the match knows who's allowed to start the round.
 */
export function createMatchRpc(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string,
): string {
  const userId = ctx.userId;
  if (!userId) throw newError('unauthenticated', 16);

  let req: CreateMatchRequest = {};
  if (payload && payload.length > 0) {
    try {
      req = JSON.parse(payload) as CreateMatchRequest;
    } catch {
      throw newError('invalid_json', 3);
    }
  }

  const matchName = (req.name ?? '').slice(0, 64) || `${ctx.username ?? 'host'}'s lobby`;
  const gameModeId = req.gameModeId ?? null;

  const matchId = nk.matchCreate(MATCH_NAME, {
    hostUserId: userId,
    matchName,
    gameModeId,
  });
  logger.info('created match=%s host=%s name=%s', matchId, userId, matchName);

  const label: MatchLabel = {
    phase: 'lobby' as MatchLabel['phase'],
    gameModeId,
    count: 0,
    hostUserId: userId,
    name: matchName,
    protocol: WIRE_PROTOCOL_VERSION,
  };
  const response: CreateMatchResponse = { matchId, label };
  return JSON.stringify(response);
}

/**
 * Browser polls this to populate the room list. Returns up to `limit` matches
 * (capped at 50) where the label JSON parses cleanly.
 */
export function listMatchesRpc(
  ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string,
): string {
  if (!ctx.userId) throw newError('unauthenticated', 16);

  let limit = 20;
  if (payload && payload.length > 0) {
    try {
      const req = JSON.parse(payload) as ListMatchesRequest;
      if (typeof req.limit === 'number') {
        limit = Math.min(50, Math.max(1, Math.floor(req.limit)));
      }
    } catch {
      // ignore — fall through to default limit
    }
  }

  // matchList semantics: passing empty-string label filters to literally-empty
  // labels. We want "any label" so pass null. Same for query.
  const matches = nk.matchList(limit, true, null, 0, MAX_PLAYERS, null);

  const listings: MatchListing[] = [];
  for (const m of matches) {
    let label: MatchLabel | null = null;
    if (m.label) {
      try {
        label = JSON.parse(m.label) as MatchLabel;
      } catch {
        label = null;
      }
    }
    if (!label) continue;
    listings.push({
      matchId: m.matchId,
      label,
      size: m.size,
    });
  }

  const response: ListMatchesResponse = { matches: listings };
  return JSON.stringify(response);
}

function newError(message: string, code: number): Error {
  const e = new Error(message);
  (e as unknown as { code: number }).code = code;
  return e;
}
