import type { Facing } from '../content/tilemap.js';
import type { ItemInstanceId } from '../ids.js';
import type { ItemInstance } from '../state/inventory.js';

// ---------- Client → Server ----------

/**
 * "Attack the tile in front of me with my equipped weapon."
 *
 * The server uses the player's current facing + equipped weapon's range to
 * compute the target tile(s); the client doesn't pick the victim. This
 * matches DM's `LethalWeapon`/`BluntWeapon` model where the player aims
 * with movement, not with the weapon.
 */
export interface C2SAttack {
  /** Optional override; if omitted the server uses `player.facing`. */
  dir?: Facing;
}

export interface C2SSearchCorpse {
  corpseId: string;
}

export interface C2STakeFromCorpse {
  corpseId: string;
  instanceId: ItemInstanceId;
}

// ---------- Server → Client ----------

/**
 * Public health snapshot — sent on every HP / alive change. Visible to all
 * (HP bars over heads). M5 will gate this per role for hidden-state modes.
 */
export interface S2CPlayerHealth {
  userId: string;
  hp: number;
  maxHp: number;
  isAlive: boolean;
}

/** Self-only HP detail (for the local HP bar). */
export interface S2CPlayerHP {
  hp: number;
  maxHp: number;
}

/** Self-only stamina. */
export interface S2CPlayerStamina {
  stamina: number;
  maxStamina: number;
}

export interface S2CPlayerDied {
  userId: string;
  killerUserId: string | null;
  /** What killed them — usually the weapon name; for fists, "fists". */
  cause: string;
  /** Final tile. */
  x: number;
  y: number;
}

export interface PublicCorpse {
  corpseId: string;
  victimUserId: string;
  victimUsername: string;
  victimRealName: string;
  x: number;
  y: number;
  /** Has anyone other than the killer found this body yet? Drives the announcement. */
  discovered: boolean;
  /** When discovered, the discoverer's userId is also reported. */
  discoveredByUserId?: string;
}

export interface S2CCorpseSpawn {
  corpse: PublicCorpse;
}

export interface S2CCorpseDespawn {
  corpseId: string;
}

/**
 * Sent in response to `C2SSearchCorpse`. Self-only — only the searcher sees
 * the contents. Discovery (the public announcement) is a separate side
 * effect of the search.
 */
export interface S2CCorpseContents {
  corpseId: string;
  contents: ItemInstance[];
}

/**
 * World-wide announcement banner (DM's `world << "<big>... Dead body
 * located..."`). M4 only fires this on first body discovery; M5+ adds
 * mode-specific announcements.
 */
export interface S2CAnnouncement {
  kind: 'body_discovered' | 'mode_event' | 'system';
  message: string;
}
