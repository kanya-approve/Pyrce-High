/**
 * Role registry. Mirrors the role flags from `Vars.dm:117-241` (`killer`,
 * `suspect`, `kira`, `isL`, `beatrice`, etc.) but introduced one role at a
 * time as the corresponding mode lands.
 *
 * v1 (M5) only ships `civilian`, `killer`, and `suspect` — the Normal-mode
 * roster. M5.x adds Witch / Zombie / etc. as content-only PRs.
 */

export type RoleId =
  | 'civilian'
  | 'killer'
  | 'suspect'
  | 'witch'
  | 'zombie'
  | 'doppelganger'
  | 'ghost'
  | 'whisperer'
  | 'vampire'
  | 'nanaya'
  | 'shinigami'
  | 'kira'
  | 'detective'
  | 'beatrice'
  | 'watcher'
  | 'escaped'
  | 'slender'
  | 'minion_zombie';

export type Allegiance = 'town' | 'killer' | 'neutral';

export interface RoleDef {
  id: RoleId;
  name: string;
  allegiance: Allegiance;
  baseHp: number;
  baseStamina: number;
  description: string;
  /** Prefix shown in body-discovery announcements. Empty = use username. */
  realNamePrefix?: string;
}

export const ROLES: Record<RoleId, RoleDef> = {
  civilian: {
    id: 'civilian',
    name: 'The Suspect',
    allegiance: 'town',
    baseHp: 100,
    baseStamina: 100,
    description: 'You are an ordinary student. Survive until 6 AM.',
  },
  killer: {
    id: 'killer',
    name: 'The Killer',
    allegiance: 'killer',
    baseHp: 100,
    baseStamina: 100,
    description: 'Slaughter every other student before dawn.',
  },
  suspect: {
    id: 'suspect',
    name: 'The Suspect',
    allegiance: 'town',
    baseHp: 100,
    baseStamina: 100,
    description: 'Civilians may suspect you. Survive until 6 AM.',
  },
  // v1.x stubs — fully described once the corresponding mode ships.
  witch: {
    id: 'witch',
    name: 'The Witch',
    allegiance: 'killer',
    baseHp: 100,
    baseStamina: 100,
    description: 'TODO',
  },
  zombie: {
    id: 'zombie',
    name: 'The Main Zombie',
    allegiance: 'killer',
    baseHp: 375,
    baseStamina: 100,
    description: 'TODO',
  },
  doppelganger: {
    id: 'doppelganger',
    name: 'The Doppelganger',
    allegiance: 'killer',
    baseHp: 200,
    baseStamina: 100,
    description: 'TODO',
  },
  ghost: {
    id: 'ghost',
    name: 'The Ghost',
    allegiance: 'town',
    baseHp: 100,
    baseStamina: 100,
    description: 'TODO',
  },
  whisperer: {
    id: 'whisperer',
    name: 'The Ghost Whisperer',
    allegiance: 'town',
    baseHp: 100,
    baseStamina: 100,
    description: 'TODO',
  },
  vampire: {
    id: 'vampire',
    name: 'The Vampire',
    allegiance: 'killer',
    baseHp: 100,
    baseStamina: 100,
    description: 'TODO',
  },
  nanaya: {
    id: 'nanaya',
    name: 'The Nanaya',
    allegiance: 'town',
    baseHp: 100,
    baseStamina: 100,
    description: 'TODO',
  },
  shinigami: {
    id: 'shinigami',
    name: 'The Shinigami',
    allegiance: 'neutral',
    baseHp: 100,
    baseStamina: 100,
    description: 'TODO',
  },
  kira: {
    id: 'kira',
    name: 'Kira',
    allegiance: 'killer',
    baseHp: 100,
    baseStamina: 100,
    description: 'TODO',
  },
  detective: {
    id: 'detective',
    name: 'The Detective',
    allegiance: 'town',
    baseHp: 100,
    baseStamina: 100,
    description: 'TODO',
  },
  beatrice: {
    id: 'beatrice',
    name: 'Beatrice',
    allegiance: 'killer',
    baseHp: 100,
    baseStamina: 100,
    description: 'TODO',
  },
  watcher: {
    id: 'watcher',
    name: 'The Watcher',
    allegiance: 'neutral',
    baseHp: 100,
    baseStamina: 100,
    description: 'You observe the round from a fixed vantage. You cannot interact.',
  },
  escaped: {
    id: 'escaped',
    name: 'The Escaped',
    allegiance: 'killer',
    baseHp: 100,
    baseStamina: 100,
    description: 'You broke out and want to break back in. Spawn at the perimeter.',
  },
  slender: {
    id: 'slender',
    name: 'Slender',
    allegiance: 'killer',
    baseHp: 200,
    baseStamina: 100,
    description: 'TODO',
  },
  minion_zombie: {
    id: 'minion_zombie',
    name: 'Zombie',
    allegiance: 'killer',
    baseHp: 100,
    baseStamina: 80,
    description: 'You succumbed to the bite. Spread the infection.',
  },
};

export function roleOf(id: RoleId): RoleDef {
  return ROLES[id];
}
