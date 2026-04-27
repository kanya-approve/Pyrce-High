/**
 * Item registry. Mirrors `/obj/Misc/*` and `/obj/weapons/*` from the DM
 * source (`Turfs.dm:478+` for misc, `:3488+` for weapons). Damage / weight /
 * cooldown values are taken from the DM definitions; `cooldownTicks` here
 * is in our 10 Hz server ticks (≈ DM's `delay` constant; close enough for
 * v1 balance — values will be tuned in M5).
 */

export type ItemCategory =
  | 'weapon'
  | 'tool'
  | 'consumable'
  | 'key'
  | 'paper'
  | 'food'
  | 'currency'
  | 'light'
  | 'electronic'
  | 'misc';

export interface WeaponSpec {
  damage: number;
  staminaCost: number;
  /** Tile reach (1 = adjacent, 2 = polearm-style). */
  range: number;
  /** Server ticks between attacks. */
  cooldownTicks: number;
  /** Whether the weapon can kill (vs. only stun / KO). */
  lethal: boolean;
}

export interface UseSpec {
  /** Effect kind — branch in the server's `useItem` handler. */
  kind:
    | 'flashlight'
    | 'glasses_toggle'
    | 'smoke_bomb'
    | 'first_aid'
    | 'syringe'
    | 'fill_syringe'
    | 'drink_soda'
    | 'death_note_write'
    | 'paper_write'
    | 'paper_airplane'
    | 'paper_view'
    | 'pda'
    | 'computer'
    | 'feather_shoot'
    | 'popper_trap'
    | 'key_card_swipe'
    | 'door_code_view';
  /** Optional payload key for sub-types (e.g. which vial fills the syringe). */
  payload?: string;
}

export interface ItemDef {
  id: string;
  name: string;
  category: ItemCategory;
  weight: number;
  /** Stack semantics. Stackable items merge on pickup; `stackSize` is per-instance unit. */
  stackable: boolean;
  stackSize?: number;
  weapon?: WeaponSpec;
  use?: UseSpec;
  /** Restrict pickup/use to a specific role id. v1: `nanatsu_yoru` only for nanaya. */
  restrictedToRole?: string;
  /** Light radius emitted when in inventory (Mystia Coin, Glow Stick). */
  lightRadius?: number;
  /** Sprite-atlas frame name. Filled in M7 alongside DMI extraction. */
  iconFrame?: string;
  /** Short flavour text shown in inventory tooltip. */
  flavour?: string;
}

// ---------- Weapons ----------
//
// Damage / staminaCost / weight / cooldown values transcribed from
// /obj/weapons/* in Turfs.dm. `cooldownTicks` is converted from the DM
// `delay` (which was in DM ticks at 15 Hz) to 10 Hz approximately.

const WEAPONS: ItemDef[] = [
  {
    id: 'knife',
    name: 'Knife',
    category: 'weapon',
    weight: 1,
    stackable: false,
    weapon: { damage: 8, staminaCost: 6, range: 1, cooldownTicks: 7, lethal: true },
  },
  {
    id: 'seventh_holy_scripture',
    name: 'Seventh Holy Scripture',
    category: 'weapon',
    weight: 15,
    stackable: false,
    weapon: { damage: 8, staminaCost: 6, range: 1, cooldownTicks: 7, lethal: true },
    flavour: 'A heavy, bloody dagger.',
  },
  {
    id: 'axe',
    name: 'Axe',
    category: 'weapon',
    weight: 10,
    stackable: false,
    weapon: { damage: 17, staminaCost: 16, range: 1, cooldownTicks: 13, lethal: true },
  },
  {
    id: 'nailed_bat',
    name: 'Nailed Bat',
    category: 'weapon',
    weight: 2,
    stackable: false,
    weapon: { damage: 13, staminaCost: 11, range: 1, cooldownTicks: 10, lethal: true },
    flavour: 'Crafted from a wooden bat, hammer and nails.',
  },
  {
    id: 'metal_pipe',
    name: 'Metal Pipe',
    category: 'weapon',
    weight: 9,
    stackable: false,
    weapon: { damage: 10, staminaCost: 10, range: 1, cooldownTicks: 10, lethal: true },
  },
  {
    id: 'alondite',
    name: 'Alondite',
    category: 'weapon',
    weight: 10,
    stackable: false,
    weapon: { damage: 17, staminaCost: 16, range: 2, cooldownTicks: 17, lethal: true },
    flavour: 'A blackened greatsword. Reaches two tiles.',
  },
  {
    id: 'taser',
    name: 'Taser',
    category: 'weapon',
    weight: 3,
    stackable: false,
    weapon: { damage: 6, staminaCost: 3, range: 1, cooldownTicks: 10, lethal: false },
  },
  {
    id: 'billhook',
    name: 'Billhook',
    category: 'weapon',
    weight: 7,
    stackable: false,
    weapon: { damage: 12, staminaCost: 10, range: 1, cooldownTicks: 10, lethal: true },
  },
  {
    id: 'wooden_bat',
    name: 'Wooden Bat',
    category: 'weapon',
    weight: 2,
    stackable: false,
    weapon: { damage: 17, staminaCost: 3, range: 1, cooldownTicks: 1, lethal: false },
  },
  {
    id: 'mop',
    name: 'Mop',
    category: 'weapon',
    weight: 2,
    stackable: false,
    weapon: { damage: 8, staminaCost: 2, range: 1, cooldownTicks: 1, lethal: false },
  },
  {
    id: 'ladle',
    name: 'Ladle',
    category: 'weapon',
    weight: 2,
    stackable: false,
    weapon: { damage: 12, staminaCost: 9, range: 1, cooldownTicks: 1, lethal: false },
  },
  {
    id: 'metal_bat',
    name: 'Metal Bat',
    category: 'weapon',
    weight: 5,
    stackable: false,
    weapon: { damage: 11, staminaCost: 9, range: 1, cooldownTicks: 10, lethal: true },
  },
  {
    id: 'bokken',
    name: 'Bokken',
    category: 'weapon',
    weight: 5,
    stackable: false,
    weapon: { damage: 12, staminaCost: 9, range: 1, cooldownTicks: 1, lethal: false },
  },
  {
    id: 'spear',
    name: 'Spear',
    category: 'weapon',
    weight: 5,
    stackable: false,
    weapon: { damage: 16, staminaCost: 16, range: 2, cooldownTicks: 16, lethal: true },
    flavour: 'Crafted from a knife, mop and tape.',
  },
  {
    id: 'fists',
    name: 'Fists',
    category: 'weapon',
    weight: 0,
    stackable: false,
    weapon: { damage: 6, staminaCost: 2, range: 1, cooldownTicks: 9, lethal: false },
    flavour: 'Always available — no inventory slot used.',
  },
  {
    id: 'nanatsu_yoru',
    name: 'Nanatsu-Yoru',
    category: 'weapon',
    weight: 1,
    stackable: false,
    weapon: { damage: 25, staminaCost: 20, range: 1, cooldownTicks: 21, lethal: true },
    restrictedToRole: 'nanaya',
    flavour: "Demon-hunter's blade. Wieldable only by Nanaya.",
  },
  {
    id: 'green_paint',
    name: 'Green Paint Spray',
    category: 'weapon',
    weight: 1,
    stackable: false,
    weapon: { damage: 6, staminaCost: 3, range: 1, cooldownTicks: 10, lethal: false },
    flavour: 'Marks targets with paint. Non-lethal.',
  },
  {
    id: 'hammer',
    name: 'Hammer',
    category: 'weapon',
    weight: 5,
    stackable: false,
    weapon: { damage: 9, staminaCost: 6, range: 1, cooldownTicks: 9, lethal: true },
  },
];

// ---------- Misc / utility / role / story items ----------

const MISC: ItemDef[] = [
  {
    id: 'flashlight',
    name: 'Flashlight',
    category: 'light',
    weight: 0.5,
    stackable: false,
    lightRadius: 4,
    use: { kind: 'flashlight' },
  },
  {
    id: 'glasses_case',
    name: 'Glasses Case',
    category: 'misc',
    weight: 0.2,
    stackable: false,
    use: { kind: 'glasses_toggle' },
    flavour: 'Removes glasses. Affects stamina drain.',
  },
  {
    id: 'black_feather',
    name: 'Black Feather',
    category: 'misc',
    weight: 0.1,
    stackable: false,
    use: { kind: 'feather_shoot' },
    flavour: 'A single black feather. Fires shots when used.',
  },
  {
    id: 'poppers',
    name: 'Poppers',
    category: 'misc',
    weight: 0,
    stackable: false,
    use: { kind: 'popper_trap' },
    flavour: 'Trip-trap. Drop on the floor.',
  },
  {
    id: 'tape',
    name: 'Tape',
    category: 'tool',
    weight: 0,
    stackable: false,
    flavour: 'Crafting reagent.',
  },
  {
    id: 'smoke_bomb',
    name: 'Smoke Bomb',
    category: 'tool',
    weight: 0,
    stackable: false,
    use: { kind: 'smoke_bomb' },
  },
  {
    id: 'first_aid_kit',
    name: 'First-Aid Kit',
    category: 'consumable',
    weight: 4,
    stackable: false,
    use: { kind: 'first_aid' },
    flavour: 'Heals about half of any missing HP.',
  },
  {
    id: 'empty_syringe',
    name: 'Empty Syringe',
    category: 'consumable',
    weight: 0.5,
    stackable: false,
    use: { kind: 'syringe' },
  },
  {
    id: 'cure_vial',
    name: 'Cure',
    category: 'consumable',
    weight: 0,
    stackable: false,
    use: { kind: 'fill_syringe', payload: 'Cure' },
    flavour: 'Vial. Fill an empty syringe.',
  },
  {
    id: 'soda',
    name: 'Soda',
    category: 'food',
    weight: 0,
    stackable: false,
    use: { kind: 'drink_soda' },
    flavour: '+10..60 stamina.',
  },
  {
    id: 'yen',
    name: 'Yen',
    category: 'currency',
    weight: 0,
    stackable: true,
    stackSize: 25,
    flavour: 'Vending-machine currency.',
  },
  {
    id: 'super_regenerative',
    name: 'Super Regenerative',
    category: 'consumable',
    weight: 0.1,
    stackable: false,
    use: { kind: 'fill_syringe', payload: 'Regenerative' },
  },
  {
    id: 'mild_sedative',
    name: 'Mild Sedative',
    category: 'consumable',
    weight: 0,
    stackable: false,
    use: { kind: 'fill_syringe', payload: 'Sedative' },
  },
  {
    id: 'death_note',
    name: 'Death Note',
    category: 'paper',
    weight: 2,
    stackable: false,
    use: { kind: 'death_note_write' },
    flavour: 'A black notebook. Heart attacks and vendettas.',
  },
  {
    id: 'death_note_fake',
    name: 'Death Note',
    category: 'paper',
    weight: 2,
    stackable: false,
    use: { kind: 'death_note_write' },
    flavour: 'Indistinguishable from the real thing — at first.',
  },
  {
    id: 'school_computer',
    name: 'School Computer',
    category: 'electronic',
    weight: 0,
    stackable: false,
    use: { kind: 'computer' },
    flavour: 'Open the student roster.',
  },
  {
    id: 'pencil',
    name: 'Pencil',
    category: 'paper',
    weight: 1,
    stackable: false,
    flavour: 'Write on paper.',
  },
  {
    id: 'nails',
    name: 'Nails',
    category: 'tool',
    weight: 0.1,
    stackable: false,
    flavour: 'Crafting reagent.',
  },
  {
    id: 'mystia_coin',
    name: 'Mystia Coin',
    category: 'misc',
    weight: 0.1,
    stackable: true,
    stackSize: 1,
    lightRadius: 2,
    flavour: 'Each coin extends your dark vision.',
  },
  {
    id: 'glow_stick',
    name: 'Glow Stick',
    category: 'light',
    weight: 0.1,
    stackable: false,
    lightRadius: 2,
  },
  {
    id: 'key_card',
    name: 'Key Card',
    category: 'key',
    weight: 0.1,
    stackable: false,
    use: { kind: 'key_card_swipe' },
    flavour: 'Unlocks the escape door.',
  },
  {
    id: 'key_card_rare',
    name: 'Key Card',
    category: 'key',
    weight: 0.1,
    stackable: false,
    use: { kind: 'key_card_swipe' },
    flavour: 'A rarer variant. Same lock.',
  },
  {
    id: 'door_code_paper',
    name: '???',
    category: 'paper',
    weight: 0.1,
    stackable: false,
    use: { kind: 'door_code_view' },
  },
  {
    id: 'strange_paper',
    name: 'Strange Paper Sheet',
    category: 'paper',
    weight: 1,
    stackable: false,
    use: { kind: 'paper_write' },
  },
  {
    id: 'paper_sheet',
    name: 'Paper Sheet',
    category: 'paper',
    weight: 1,
    stackable: false,
    use: { kind: 'paper_airplane' },
  },
  {
    id: 'dn_paper_sheet',
    name: 'Death Note Page',
    category: 'paper',
    weight: 1,
    stackable: false,
    use: { kind: 'paper_write' },
  },
  {
    id: 'pda',
    name: 'PDA',
    category: 'electronic',
    weight: 0,
    stackable: false,
    use: { kind: 'pda' },
  },
];

export const ITEMS: Record<string, ItemDef> = {};
for (const def of [...WEAPONS, ...MISC]) ITEMS[def.id] = def;

/** Stable list of all item ids — useful for content validation + admin tooling. */
export const ALL_ITEM_IDS: string[] = Object.keys(ITEMS);

export function getItem(id: string): ItemDef | undefined {
  return ITEMS[id];
}

// ---------- Crafting ----------

export interface RecipeDef {
  id: string;
  output: string;
  /** Map of item id → required count. All inputs consumed on craft. */
  inputs: Record<string, number>;
}

export const RECIPES: RecipeDef[] = [
  {
    id: 'spear',
    output: 'spear',
    inputs: { knife: 1, mop: 1, tape: 1 },
  },
  {
    id: 'nailed_bat',
    output: 'nailed_bat',
    inputs: { wooden_bat: 1, hammer: 1, nails: 1 },
  },
];

export const RECIPES_BY_ID: Record<string, RecipeDef> = {};
for (const r of RECIPES) RECIPES_BY_ID[r.id] = r;
