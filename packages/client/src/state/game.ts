import type { S2CClockTick, S2CGameResult, S2CRoleAssigned } from '@pyrce/shared';

/**
 * Per-round client mirror of mode-engine state. Mutated by the GameWorld
 * scene as broadcasts arrive; read by Hud and EndScene.
 */
export interface ClientGameInfo {
  role: S2CRoleAssigned | null;
  clock: S2CClockTick | null;
  result: S2CGameResult | null;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
}

export function newClientGameInfo(): ClientGameInfo {
  return {
    role: null,
    clock: null,
    result: null,
    hp: 100,
    maxHp: 100,
    stamina: 100,
    maxStamina: 100,
  };
}
