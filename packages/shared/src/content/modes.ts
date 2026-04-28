/**
 * Game-mode registry — the data-driven core of the "Mystery Script" idea
 * from the plan. Each mode is a `GameModeDef` of role-distribution rules,
 * starting items, and win conditions, plus an optional `scriptId` that
 * lets a mode reference an imperative server-side helper for things that
 * can't be expressed declaratively (Death Note's scheduled deaths, Witch
 * resurrection rules, etc.).
 *
 * v1 (M5) ships only `normal`. M5.x will add the others as content-only
 * PRs that drop in here without server changes — the engine in
 * `packages/server/src/mode.ts` is mode-agnostic.
 */

import type { RoleId } from './roles.js';

export type GameModeId =
  | 'normal'
  | 'witch'
  | 'zombie'
  | 'doppelganger'
  | 'secret'
  | 'ghost'
  | 'vampire'
  | 'death_note'
  | 'death_note_classic'
  | 'extended'
  | 'slender';

export interface RoleAssignment {
  roleId: RoleId;
  /** Either a fixed count or 'fillRemaining' to mop up everyone left. */
  count: number | 'fillRemaining';
  /** Probability gate (0..1) — if rolled false, this assignment is skipped. */
  probability?: number;
  /** Minimum total players required for this assignment to kick in. */
  minPlayers?: number;
}

export interface ItemGrant {
  /** Role id this grant applies to (everyone with that role gets the item). */
  roleId: RoleId;
  /** Item id from ITEMS registry. */
  itemId: string;
  /** Stack count for stackables; ignored for non-stackable. */
  count?: number;
  /** If true, server auto-equips the item after granting. */
  equip?: boolean;
  /** If set, server auto-binds it to this hotkey slot (1..5). */
  hotkey?: 1 | 2 | 3 | 4 | 5;
}

export type WinCondition =
  | { type: 'lastFactionStanding'; winningAllegiance?: 'town' | 'killer' }
  | {
      type: 'timeUp';
      gameHour: number;
      ampm: 'AM' | 'PM';
      winningAllegiance: 'town' | 'killer' | 'survivors';
    }
  | { type: 'roleEliminated'; roleId: RoleId; winningAllegiance: 'town' | 'killer' };

export interface GameModeDef {
  id: GameModeId;
  displayName: string;
  description: string;
  minPlayers: number;
  setup: {
    roles: RoleAssignment[];
    items: ItemGrant[];
  };
  /** Win conditions evaluated each tick; first matching wins. */
  winConditions: WinCondition[];
  /** Optional named server script bundle (registry lookup in `server/src/modeScripts/`). */
  scriptId?: string;
}

const NORMAL: GameModeDef = {
  id: 'normal',
  displayName: 'Normal',
  description: 'A killer hides among students. Survive until 6 AM or eliminate the killer.',
  minPlayers: 2,
  setup: {
    roles: [
      { roleId: 'killer', count: 1 },
      { roleId: 'suspect', count: 1, probability: 0.25, minPlayers: 4 },
      { roleId: 'civilian', count: 'fillRemaining' },
    ],
    items: [{ roleId: 'killer', itemId: 'knife', equip: true, hotkey: 1 }],
  },
  winConditions: [
    { type: 'roleEliminated', roleId: 'killer', winningAllegiance: 'town' },
    { type: 'lastFactionStanding' },
    { type: 'timeUp', gameHour: 6, ampm: 'AM', winningAllegiance: 'survivors' },
  ],
};

const EXTENDED: GameModeDef = {
  id: 'extended',
  displayName: 'Extended',
  description: 'Pure survival — no killer assigned. Make it to 6 AM.',
  minPlayers: 2,
  setup: {
    roles: [{ roleId: 'civilian', count: 'fillRemaining' }],
    items: [],
  },
  winConditions: [
    { type: 'timeUp', gameHour: 6, ampm: 'AM', winningAllegiance: 'survivors' },
  ],
};

const WITCH: GameModeDef = {
  id: 'witch',
  displayName: 'Witch',
  description: 'A witch among students kills with cursed butterflies. Witch can revive up to 5 times.',
  minPlayers: 4,
  setup: {
    roles: [
      { roleId: 'witch', count: 1 },
      { roleId: 'civilian', count: 'fillRemaining' },
    ],
    items: [{ roleId: 'witch', itemId: 'knife', equip: true, hotkey: 1 }],
  },
  winConditions: [
    { type: 'roleEliminated', roleId: 'witch', winningAllegiance: 'town' },
    { type: 'lastFactionStanding' },
    { type: 'timeUp', gameHour: 6, ampm: 'AM', winningAllegiance: 'survivors' },
  ],
  scriptId: 'witch',
};

const ZOMBIE: GameModeDef = {
  id: 'zombie',
  displayName: 'Zombie',
  description: 'A 375-HP main zombie infects on contact. The infected eventually turn.',
  minPlayers: 4,
  setup: {
    roles: [
      { roleId: 'zombie', count: 1 },
      { roleId: 'civilian', count: 'fillRemaining' },
    ],
    items: [],
  },
  winConditions: [
    { type: 'roleEliminated', roleId: 'zombie', winningAllegiance: 'town' },
    { type: 'lastFactionStanding' },
    { type: 'timeUp', gameHour: 6, ampm: 'AM', winningAllegiance: 'survivors' },
  ],
  scriptId: 'zombie',
};

const DOPPELGANGER: GameModeDef = {
  id: 'doppelganger',
  displayName: 'Doppelganger',
  description: '200 HP killer that can copy a corpse to disguise itself. Trust no one.',
  minPlayers: 4,
  setup: {
    roles: [
      { roleId: 'doppelganger', count: 1 },
      { roleId: 'civilian', count: 'fillRemaining' },
    ],
    items: [{ roleId: 'doppelganger', itemId: 'knife', equip: true, hotkey: 1 }],
  },
  winConditions: [
    { type: 'roleEliminated', roleId: 'doppelganger', winningAllegiance: 'town' },
    { type: 'lastFactionStanding' },
    { type: 'timeUp', gameHour: 6, ampm: 'AM', winningAllegiance: 'survivors' },
  ],
};

const SECRET: GameModeDef = {
  id: 'secret',
  displayName: 'Secret',
  description: 'A random hidden role plays out. Nobody knows the rules until they trigger.',
  minPlayers: 4,
  setup: {
    roles: [
      { roleId: 'killer', count: 1 },
      { roleId: 'civilian', count: 'fillRemaining' },
    ],
    items: [{ roleId: 'killer', itemId: 'knife', equip: true, hotkey: 1 }],
  },
  winConditions: [
    { type: 'roleEliminated', roleId: 'killer', winningAllegiance: 'town' },
    { type: 'lastFactionStanding' },
    { type: 'timeUp', gameHour: 6, ampm: 'AM', winningAllegiance: 'survivors' },
  ],
  scriptId: 'secret',
};

const GHOST: GameModeDef = {
  id: 'ghost',
  displayName: 'Ghost',
  description: 'An invisible spirit kills the unsuspecting; a Whisperer can sense it.',
  minPlayers: 4,
  setup: {
    roles: [
      { roleId: 'ghost', count: 1 },
      { roleId: 'whisperer', count: 1, probability: 0.5, minPlayers: 6 },
      { roleId: 'civilian', count: 'fillRemaining' },
    ],
    items: [],
  },
  winConditions: [
    { type: 'roleEliminated', roleId: 'ghost', winningAllegiance: 'town' },
    { type: 'lastFactionStanding' },
    { type: 'timeUp', gameHour: 6, ampm: 'AM', winningAllegiance: 'survivors' },
  ],
  scriptId: 'ghost',
};

const VAMPIRE: GameModeDef = {
  id: 'vampire',
  displayName: 'Vampire',
  description: 'A vampire stalks the school. A Nanaya stalks the vampire.',
  minPlayers: 4,
  setup: {
    roles: [
      { roleId: 'vampire', count: 1 },
      { roleId: 'nanaya', count: 1, probability: 0.5, minPlayers: 6 },
      { roleId: 'civilian', count: 'fillRemaining' },
    ],
    items: [
      { roleId: 'vampire', itemId: 'knife', equip: true, hotkey: 1 },
      { roleId: 'nanaya', itemId: 'nanatsu_yoru', equip: true, hotkey: 1 },
    ],
  },
  winConditions: [
    { type: 'roleEliminated', roleId: 'vampire', winningAllegiance: 'town' },
    { type: 'lastFactionStanding' },
    { type: 'timeUp', gameHour: 6, ampm: 'AM', winningAllegiance: 'survivors' },
  ],
  scriptId: 'vampire',
};

const DEATH_NOTE: GameModeDef = {
  id: 'death_note',
  displayName: 'Death Note',
  description: 'Kira writes names; the Shinigami watches. Civilians die mysteriously.',
  minPlayers: 4,
  setup: {
    roles: [
      { roleId: 'kira', count: 1 },
      { roleId: 'shinigami', count: 1 },
      { roleId: 'civilian', count: 'fillRemaining' },
    ],
    items: [{ roleId: 'kira', itemId: 'death_note', equip: true, hotkey: 1 }],
  },
  winConditions: [
    { type: 'roleEliminated', roleId: 'kira', winningAllegiance: 'town' },
    { type: 'lastFactionStanding' },
    { type: 'timeUp', gameHour: 6, ampm: 'AM', winningAllegiance: 'killer' },
  ],
  scriptId: 'death_note',
};

const DEATH_NOTE_CLASSIC: GameModeDef = {
  id: 'death_note_classic',
  displayName: 'Death Note Classic',
  description: 'Kira alone. No Shinigami helper, no Eyes. Pure paranoia.',
  minPlayers: 4,
  setup: {
    roles: [
      { roleId: 'kira', count: 1 },
      { roleId: 'civilian', count: 'fillRemaining' },
    ],
    items: [{ roleId: 'kira', itemId: 'death_note', equip: true, hotkey: 1 }],
  },
  winConditions: [
    { type: 'roleEliminated', roleId: 'kira', winningAllegiance: 'town' },
    { type: 'lastFactionStanding' },
    { type: 'timeUp', gameHour: 6, ampm: 'AM', winningAllegiance: 'killer' },
  ],
  scriptId: 'death_note',
};

const SLENDER: GameModeDef = {
  id: 'slender',
  displayName: 'Slender',
  description: 'Slenderman stalks the school. Find pages, escape before he finds you.',
  minPlayers: 4,
  setup: {
    roles: [
      { roleId: 'slender', count: 1 },
      { roleId: 'civilian', count: 'fillRemaining' },
    ],
    items: [],
  },
  winConditions: [
    { type: 'roleEliminated', roleId: 'slender', winningAllegiance: 'town' },
    { type: 'lastFactionStanding' },
    { type: 'timeUp', gameHour: 6, ampm: 'AM', winningAllegiance: 'survivors' },
  ],
  scriptId: 'slender',
};

export const MODES: Record<GameModeId, GameModeDef | undefined> = {
  normal: NORMAL,
  extended: EXTENDED,
  witch: WITCH,
  zombie: ZOMBIE,
  doppelganger: DOPPELGANGER,
  secret: SECRET,
  ghost: GHOST,
  vampire: VAMPIRE,
  death_note: DEATH_NOTE,
  death_note_classic: DEATH_NOTE_CLASSIC,
  slender: SLENDER,
};

export function getMode(id: string): GameModeDef | undefined {
  return MODES[id as GameModeId] ?? undefined;
}

export const ALL_MODE_IDS: GameModeId[] = Object.keys(MODES) as GameModeId[];
