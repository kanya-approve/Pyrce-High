/**
 * Per-user profile persisted in Nakama Storage (collection: "profile", key: "main").
 *
 * Schema-versioned so future migrations can detect & upgrade old payloads.
 * Mirrors the per-key fields from the BYOND `Save users.dm` save format —
 * see `Save users.dm:1-49` for the legacy reference.
 */
export interface CharSlot {
  characterName: string;
  hairId: string;
  hairColor: string;
  gender: 'male' | 'female';
}

export interface ProfileV1 {
  schemaVersion: 1;
  characterName: string;
  hairId: string;
  hairColor: string;
  gender: 'male' | 'female';
  chatColor: string;
  unlocks: string[];
  ignoreList: string[];
  charSlots: [CharSlot | null, CharSlot | null, CharSlot | null];
}

export const EMPTY_PROFILE: ProfileV1 = {
  schemaVersion: 1,
  characterName: '',
  hairId: '',
  hairColor: '#000000',
  gender: 'male',
  chatColor: '#ffffff',
  unlocks: [],
  ignoreList: [],
  charSlots: [null, null, null],
};
