/**
 * Atlas frame keys produced by `tools/dmi-extract`. Format is
 * `${source}/${state}/${dir}/${frame}` where source is the .dmi path under
 * `assets/dmi-source/` (sans extension), state is lowercase + underscored,
 * dir is BYOND's compass code (S/N/E/W/SE/SW/NE/NW; 1-dir states only emit S).
 *
 * Unmapped items fall back to placeholder rectangles in the client (the few
 * entries below where a DMI sprite doesn't exist).
 */

export const ATLAS_KEY = 'sprites';
export const ATLAS_PNG = '/atlases/sprites.png';
export const ATLAS_JSON = '/atlases/sprites.json';

/** Single-frame sprite keys keyed by item id (matches `ITEMS` in items.ts). */
export const ITEM_SPRITES: Record<string, string | undefined> = {
  knife: 'mh-icons/inventoryweapons/knife/S/0',
  axe: 'mh-icons/inventoryweapons/axe/S/0',
  alondite: 'mh-icons/inventoryweapons/alondite/S/0',
  taser: 'mh-icons/inventoryweapons/taser/S/0',
  billhook: 'mh-icons/inventoryweapons/billhook/S/0',
  spear: 'mh-icons/inventoryweapons/spear/S/0',
  mop: 'mh-icons/inventoryweapons/mop/S/0',
  metal_bat: 'mh-icons/inventoryweapons/metal_bat/S/0',
  nailed_bat: 'mh-icons/inventoryweapons/nailed_bat/S/0',
  nanatsu_yoru: 'mh-icons/inventoryweapons/nanatsu/S/0',
  hammer: 'mh-icons/inventoryweapons/hammer/S/0',
  seventh_holy_scripture: 'mh-icons/inventoryweapons/seven/S/0',
  // Items without an exact match — fall through to placeholder.
  wooden_bat: 'mh-icons/inventoryweapons/bat/S/0',
  metal_pipe: 'mh-icons/inventoryweapons/pipe/S/0',
  ladle: 'mh-icons/inventoryweapons/ladel/S/0',
  bokken: 'mh-icons/inventoryweapons/boken/S/0',
  green_paint: 'mh-icons/inventoryweapons/green_paint/S/0',

  flashlight: 'mh-icons/items_miscellaneous/flashlight/S/0',
  smoke_bomb: 'mh-icons/items_miscellaneous/smoke_bomb/S/0',
  first_aid_kit: 'mh-icons/items_miscellaneous/first_aid_kit/S/0',
  death_note: 'mh-icons/items_miscellaneous/death_note/S/0',
  death_note_fake: 'mh-icons/items_miscellaneous/death_note/S/0',
  pencil: 'mh-icons/items_miscellaneous/pencil/S/0',
  nails: 'mh-icons/items_miscellaneous/nails/S/0',
  glow_stick: 'mh-icons/items_miscellaneous/glow_stick/S/0',
  poppers: 'mh-icons/items_miscellaneous/poppers/S/0',
  tape: 'mh-icons/items_miscellaneous/tape/S/0',
  empty_syringe: 'mh-icons/items_miscellaneous/syringe_empty/S/0',
  cure_vial: 'mh-icons/items_miscellaneous/syringe_full/S/0',
  glasses_case: 'mh-icons/items_miscellaneous/glasses_case/S/0',
  black_feather: 'mh-icons/items_miscellaneous/feather/S/0',
  pda: 'mh-icons/items_miscellaneous/pda/S/0',
  key_card: 'mh-icons/items_miscellaneous/keycard/S/0',
  key_card_rare: 'mh-icons/items_miscellaneous/keycard2/S/0',
  paper_sheet: 'mh-icons/items_miscellaneous/paper_sheet/S/0',
  dn_paper_sheet: 'mh-icons/items_miscellaneous/paper_sheet/S/0',
  door_code_paper: 'mh-icons/items_miscellaneous/notepaper/S/0',
  strange_paper: 'mh-icons/items_miscellaneous/notepaper/S/0',
};

/** Per-direction idle frame for the default human male/female base sprites. */
export const CHARACTER_SPRITES = {
  male: {
    S: 'hair-overlays/MaleBase/_/S/0',
    N: 'hair-overlays/MaleBase/_/N/0',
    E: 'hair-overlays/MaleBase/_/E/0',
    W: 'hair-overlays/MaleBase/_/W/0',
  },
  female: {
    S: 'hair-overlays/FemaleBase/_/S/0',
    N: 'hair-overlays/FemaleBase/_/N/0',
    E: 'hair-overlays/FemaleBase/_/E/0',
    W: 'hair-overlays/FemaleBase/_/W/0',
  },
  dead_male: 'hair-overlays/MaleBase/dead/S/0',
  dead_female: 'hair-overlays/FemaleBase/dead/S/0',
} as const;

/** Walking animation frames for a character (4 dirs × 4 frames). */
export function characterWalkFrames(
  base: 'MaleBase' | 'FemaleBase',
  dir: 'S' | 'N' | 'E' | 'W',
): string[] {
  return [0, 1, 2, 3].map((f) => `hair-overlays/${base}/_/${dir}/${f}`);
}
