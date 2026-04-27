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
  | 'extended';

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

export const MODES: Record<GameModeId, GameModeDef | undefined> = {
  normal: NORMAL,
  witch: undefined,
  zombie: undefined,
  doppelganger: undefined,
  secret: undefined,
  ghost: undefined,
  vampire: undefined,
  death_note: undefined,
  death_note_classic: undefined,
  extended: undefined,
};

export function getMode(id: string): GameModeDef | undefined {
  return MODES[id as GameModeId] ?? undefined;
}

export const ALL_MODE_IDS: GameModeId[] = Object.keys(MODES) as GameModeId[];
