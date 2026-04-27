import type { GameModeId } from '../content/modes.js';
import type { RoleId } from '../content/roles.js';

// ---------- Server → Client ----------

/** Self-only role assignment sent at game start. Contains the player's true role. */
export interface S2CRoleAssigned {
  roleId: RoleId;
  roleName: string;
  description: string;
  realName: string;
}

/** Public broadcast of in-game time. Drives the day/night client tint. */
export interface S2CClockTick {
  gameHour: number;
  ampm: 'AM' | 'PM';
  /** Hours remaining until 6 AM. Useful for UI countdown. */
  hoursLeft: number;
}

export interface RoleReveal {
  userId: string;
  username: string;
  roleId: RoleId;
  isAlive: boolean;
}

/** Broadcast when the round ends. Drives the EndScene. */
export interface S2CGameResult {
  modeId: GameModeId;
  /** Reason for the end ('time_up' | 'last_faction_standing' | 'role_eliminated'). */
  reason: string;
  /** Brief human-readable summary line. */
  summary: string;
  /** All players, with their true roles revealed. */
  reveals: RoleReveal[];
  /** Subset of reveals that count as winners. */
  winners: RoleReveal[];
}
