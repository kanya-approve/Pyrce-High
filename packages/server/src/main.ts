import { WIRE_PROTOCOL_VERSION } from '@pyrce/shared';
import {
  MATCH_NAME,
  matchInit,
  matchJoin,
  matchJoinAttempt,
  matchLeave,
  matchLoop,
  matchSignal,
  matchTerminate,
} from './matches/pyrceRoom.js';
import { createMatchRpc, listMatchesRpc } from './rpc/match.js';
import { loadProfileRpc, saveProfileRpc } from './rpc/profile.js';

/**
 * Nakama runtime entrypoint. Constraints (verified the hard way):
 *
 * 1. `InitModule` must be a top-level **function declaration** (not a `const`
 *    arrow). Nakama's `extractRpcFn` parses the function's source to learn
 *    which named function was passed to each `registerRpc(key, fn)` call.
 *
 * 2. Every function passed to `registerRpc` / `registerMatch` must be a
 *    **bare identifier** in the InitModule body and must resolve to a real
 *    function on `globalThis` at invocation time. Rollup's CJS wrapper would
 *    otherwise scope our handlers to the module body, invisible to Nakama.
 *
 * 3. The handlers themselves must be named function declarations so Goja's
 *    `.name` reflection works.
 *
 * Failing any of those gives the famously misleading error:
 *   "failed to find InitModule function"
 */
const g = globalThis as unknown as {
  InitModule: nkruntime.InitModule;
  loadProfileRpc: typeof loadProfileRpc;
  saveProfileRpc: typeof saveProfileRpc;
  createMatchRpc: typeof createMatchRpc;
  listMatchesRpc: typeof listMatchesRpc;
  matchInit: typeof matchInit;
  matchJoinAttempt: typeof matchJoinAttempt;
  matchJoin: typeof matchJoin;
  matchLeave: typeof matchLeave;
  matchLoop: typeof matchLoop;
  matchTerminate: typeof matchTerminate;
  matchSignal: typeof matchSignal;
};

g.loadProfileRpc = loadProfileRpc;
g.saveProfileRpc = saveProfileRpc;
g.createMatchRpc = createMatchRpc;
g.listMatchesRpc = listMatchesRpc;
g.matchInit = matchInit;
g.matchJoinAttempt = matchJoinAttempt;
g.matchJoin = matchJoin;
g.matchLeave = matchLeave;
g.matchLoop = matchLoop;
g.matchTerminate = matchTerminate;
g.matchSignal = matchSignal;

function InitModule(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  initializer: nkruntime.Initializer,
): void {
  // RPC keys MUST be string literals — Nakama's `extractRpcFn` parses the
  // InitModule AST statically and can't resolve member expressions like
  // `RpcId.LoadProfile`. Keep these in sync with `RpcId` in @pyrce/shared.
  initializer.registerRpc('loadProfile', loadProfileRpc);
  initializer.registerRpc('saveProfile', saveProfileRpc);
  initializer.registerRpc('createMatch', createMatchRpc);
  initializer.registerRpc('listMatches', listMatchesRpc);

  initializer.registerMatch(MATCH_NAME, {
    matchInit,
    matchJoinAttempt,
    matchJoin,
    matchLeave,
    matchLoop,
    matchTerminate,
    matchSignal,
  });

  logger.info('pyrce_high init — protocol=%s', WIRE_PROTOCOL_VERSION);
}

g.InitModule = InitModule;
