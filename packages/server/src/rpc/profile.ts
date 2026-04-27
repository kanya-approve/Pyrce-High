import {
  EMPTY_PROFILE,
  type LoadProfileResponse,
  type ProfileV1,
  type SaveProfileRequest,
  type SaveProfileResponse,
} from '@pyrce/shared';

const PROFILE_COLLECTION = 'profile';
const PROFILE_KEY = 'main';

/**
 * Load the caller's profile. Creates a default record if missing so the
 * client always gets a valid payload back.
 *
 * Note: Nakama's JS runtime expects RPC handlers to be named function
 * declarations (Goja's `.name` inference on const arrow assignments is
 * unreliable). Hence the `function` keyword everywhere in this file.
 */
export function loadProfileRpc(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  _payload: string,
): string {
  const userId = ctx.userId;
  if (!userId) throw newError('unauthenticated', 16);

  const reads = nk.storageRead([{ collection: PROFILE_COLLECTION, key: PROFILE_KEY, userId }]);

  let profile: ProfileV1;
  let created = false;

  const existing = reads[0];
  if (!existing) {
    profile = { ...EMPTY_PROFILE };
    nk.storageWrite([
      {
        collection: PROFILE_COLLECTION,
        key: PROFILE_KEY,
        userId,
        value: profile as unknown as { [k: string]: unknown },
        permissionRead: 1, // owner only
        permissionWrite: 0, // server only
      },
    ]);
    created = true;
    logger.info('created default profile for user=%s', userId);
  } else {
    profile = existing.value as unknown as ProfileV1;
    if (!profile || profile.schemaVersion !== 1) {
      // Corrupt or future-version blob — overwrite with defaults rather than
      // crash. Future migrations land here.
      profile = { ...EMPTY_PROFILE };
      nk.storageWrite([
        {
          collection: PROFILE_COLLECTION,
          key: PROFILE_KEY,
          userId,
          value: profile as unknown as { [k: string]: unknown },
          permissionRead: 1,
          permissionWrite: 0,
        },
      ]);
      logger.warn('reset corrupt profile for user=%s', userId);
    }
  }

  const response: LoadProfileResponse = { profile, created };
  return JSON.stringify(response);
}

/**
 * Overwrite the caller's profile. Light validation only — full schema
 * validation will live in @pyrce/shared (zod) once we add it.
 */
export function saveProfileRpc(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string,
): string {
  const userId = ctx.userId;
  if (!userId) throw newError('unauthenticated', 16);

  let req: SaveProfileRequest;
  try {
    req = JSON.parse(payload) as SaveProfileRequest;
  } catch {
    throw newError('invalid_json', 3);
  }
  if (!req?.profile || req.profile.schemaVersion !== 1) {
    throw newError('invalid_profile', 3);
  }

  nk.storageWrite([
    {
      collection: PROFILE_COLLECTION,
      key: PROFILE_KEY,
      userId,
      value: req.profile as unknown as { [k: string]: unknown },
      permissionRead: 1,
      permissionWrite: 0,
    },
  ]);
  logger.info('saved profile for user=%s', userId);

  const response: SaveProfileResponse = { ok: true, saved: req.profile };
  return JSON.stringify(response);
}

function newError(message: string, code: number): Error {
  const e = new Error(message);
  // Nakama's runtime uses an attached `.code` field to map JS errors → gRPC codes.
  (e as unknown as { code: number }).code = code;
  return e;
}
