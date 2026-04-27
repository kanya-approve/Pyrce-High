/**
 * Heuristic passability + category classification for BYOND turf type paths.
 *
 * Doors are classified as "door" so the runtime can render them differently
 * (the M2 server treats them as blocked; M3+ wires open/close state).
 *
 * Anything we can't classify defaults to passable=false to avoid letting
 * players walk into the void on a missed case.
 */

export type TurfCategory = 'floor' | 'wall' | 'door' | 'void' | 'unknown';

export function classifyTurf(path: string): { passable: boolean; category: TurfCategory } {
  if (path === '/turf' || path === '/turf/VoidWalls' || path === '/turf/fakewall') {
    return { passable: false, category: 'void' };
  }
  const lower = path.toLowerCase();
  // Walls and the explicit "void" border.
  if (lower.includes('wall') || lower.includes('void')) {
    return { passable: false, category: 'wall' };
  }
  // Floor-like turfs (substring match anywhere in path, case-insensitive).
  // Order matters less here; we just need to recognise BYOND's various
  // floor naming dialects (`School_Floor`, `Stone_Path`, `Tatami_floor2`,
  // `theaterfloor`, `janitorsfloor`, `stairs`, `Staris_*`, etc.).
  const floorTerms = [
    'floor',
    'grass',
    'stone_path',
    'theater',
    'janitors',
    'stairs',
    'staris_',
    'rugs/',
    'floor_turfs/',
    'tatami',
    'rug',
    'outside',
    'court_yard',
    'lounge',
    'office',
    'basement_floor',
    'freezer/wall_floor',
  ];
  for (const term of floorTerms) {
    if (lower.includes(term)) {
      return { passable: true, category: 'floor' };
    }
  }
  return { passable: false, category: 'unknown' };
}

export function objectIsDoor(path: string): boolean {
  return /\/obj\/[^/]*[Dd]oor/.test(path);
}

export function objectIsContainer(path: string): boolean {
  return /\/obj\/Containers/.test(path);
}

export function objectIsSpawn(path: string): boolean {
  return path.startsWith('/obj/Spawns');
}

export function spawnIdOf(path: string): string | null {
  const m = /\/obj\/Spawns\/([A-Za-z0-9_]+)/.exec(path);
  return m?.[1] ? m[1] : null;
}
