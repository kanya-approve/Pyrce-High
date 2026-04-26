import { WIRE_PROTOCOL_VERSION } from '@pyrce/shared';

/**
 * Nakama runtime entrypoint. Goja loads this CommonJS bundle and looks for
 * `InitModule` on the VM globals; we assign to `globalThis` explicitly so
 * Rollup can't tree-shake the function and so the lookup is unambiguous.
 */
const InitModule: nkruntime.InitModule = (
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  _initializer: nkruntime.Initializer,
): void => {
  logger.info(
    'pyrce_high init — runtime version=%s nakama=%s node=%s',
    WIRE_PROTOCOL_VERSION,
    ctx.env.RUNTIME_VERSION ?? 'unknown',
    ctx.env.NODE ?? 'unknown',
  );

  // RPC, match, and hook registration land in M1+. M0 just confirms boot.
};

// Expose InitModule to the Goja VM. The cast is necessary because
// `globalThis` doesn't carry our Nakama runtime ambient types.
(globalThis as unknown as { InitModule: nkruntime.InitModule }).InitModule = InitModule;
