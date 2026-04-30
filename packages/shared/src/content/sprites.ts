/**
 * Atlas frame keys for the rendered sprite sheet at
 * `packages/client/public/atlases/sprites.{png,json}`. Format is
 * `${source}/${state}/${dir}/${frame}` where dir is the compass code
 * (S/N/E/W/SE/SW/NE/NW). Unmapped items fall back to placeholder
 * rectangles in the client.
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

/**
 * Bloody-variant sprite for an item id, when one exists in the atlas.
 * After a kill the server flags the equipped weapon with bloody=true; the
 * client renders this frame in place of the normal one.
 */
export const BLOODY_ITEM_SPRITES: Record<string, string | undefined> = {
  knife: 'mh-icons/inventoryweapons/bloody_knife/S/0',
  axe: 'mh-icons/inventoryweapons/bloody_axe/S/0',
  alondite: 'mh-icons/inventoryweapons/bloody_alondite/S/0',
  billhook: 'mh-icons/inventoryweapons/bloody_billhook/S/0',
  metal_bat: 'mh-icons/inventoryweapons/bloody_metal_bat/S/0',
  metal_pipe: 'mh-icons/inventoryweapons/bloody_pipe/S/0',
  nailed_bat: 'mh-icons/inventoryweapons/bloody_nailed_bat/S/0',
  hammer: 'mh-icons/inventoryweapons/bloody_hammer/S/0',
  nanatsu_yoru: 'mh-icons/inventoryweapons/bloody_nanatsu/S/0',
  seventh_holy_scripture: 'mh-icons/inventoryweapons/bloody_seven/S/0',
};

/** Container kind (DM /obj path) → atlas frame for the closed default state. */
export const CONTAINER_SPRITES: Record<string, string | undefined> = {
  '/obj/Containers/Bat_Bin': 'mh-icons/containers/bat_bin/S/0',
  '/obj/Containers/Book_Shelf': 'mh-icons/containers/bookshelf_1/S/0',
  '/obj/Containers/Drawers': 'mh-icons/containers/drawers/S/0',
  '/obj/Containers/School_Desk': 'mh-icons/containers/school_desk/S/0',
  '/obj/Containers/Teachers_Desk': 'mh-icons/containers/teacherdesk1/S/0',
  '/obj/Containers/Trash_Can': 'mh-icons/containers/trash_can/S/0',
  '/obj/Containers/Wooden_Box': 'mh-icons/containers/large_wooden_box/S/0',
  '/obj/Containers_Stationed/Counter': 'mh-icons/containers/cabinet/S/0',
  '/obj/Containers_Stationed/Locker': 'mh-icons/containers/key_locker/S/0',
  '/obj/Containers_Stationed/Office_Desk': 'mh-icons/containers/desk_1/S/0',
  '/obj/Containers_Stationed/Refigorator_Bottom': 'mh-icons/containers/fridge_2/S/0',
};

/** Door kind → {closed, open} atlas frames. */
export const DOOR_SPRITES: Record<string, { closed: string; open: string } | undefined> = {
  '/obj/Door/Door_Open_Right': {
    closed: 'mh-icons/school/door/S/0',
    open: 'mh-icons/school/open_door/S/0',
  },
  '/obj/Door/Door_Open_Up': {
    closed: 'mh-icons/school/door2/S/0',
    open: 'mh-icons/school/open_door/S/0',
  },
  '/obj/Door/Door2': {
    closed: 'mh-icons/school/door2/S/0',
    open: 'mh-icons/school/open_door/S/0',
  },
  '/obj/Door/Strong_Door': {
    closed: 'mh-icons/school/front_door/S/0',
    open: 'mh-icons/school/open_strong_door/S/0',
  },
  '/obj/Doors/Toilet_Door': {
    closed: 'mh-icons/school/door/S/0',
    open: 'mh-icons/school/open_bathroom_door/S/0',
  },
  '/obj/Escape_Door': {
    closed: 'mh-icons/school/front_door/S/0',
    open: 'mh-icons/school/open_strong_door/S/0',
  },
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

/** Curated set of male/female hair overlay sources we ship as cosmetic options. */
export const HAIR_OPTIONS_MALE = [
  'BlackBoyHair',
  'BlondeBoyHair',
  'BlueBoyHair',
  'BrownBoyHair',
  'GrayBoyHair',
  'GoggleHair',
  'GreenBoyHair',
  'OrangeBoyHair',
  'PurpleBoyHair',
  'RedBoyHair',
] as const;

export const HAIR_OPTIONS_FEMALE = [
  'BlackGirlHair',
  'BlondeGirlHair',
  'BlueGirlHair',
  'BrownGirlHair',
  'GrayGirlHair',
  'GreenGirlHair',
  'OrangeGirlHair',
  'PurpleGirlHair',
  'RedGirlHair',
] as const;

export function hairFrame(hairId: string, dir: 'S' | 'N' | 'E' | 'W', frame = 0): string {
  return `hair-overlays/${hairId}/_/${dir}/${frame}`;
}

export function hairWalkFrames(hairId: string, dir: 'S' | 'N' | 'E' | 'W'): string[] {
  return [0, 1, 2, 3].map((f) => hairFrame(hairId, dir, f));
}
