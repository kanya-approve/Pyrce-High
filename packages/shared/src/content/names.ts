import { HAIR_OPTIONS_FEMALE, HAIR_OPTIONS_MALE } from './sprites.js';

export const MALE_FIRST_NAMES = [
  'Akako','Akemi','Akihiko','Akio','Akito','Akira','Bakin','Bakusui','Basho',
  'Bishamon','Bokusui','Bokuyo','Botan','Chika','Chikaaki','Chikamasa','Chikao',
  'Chishin','Dai','Daichi','Daigoro','Daishiro','Daisuke','Daitaro','Den',
  'Denji','Doho','Doni','Eiichi','Eiji','Fuyu','Gen','Genjiro','Gendo','Genji',
  'Genkei','Ginjiro','Gohachiro','Gokomatsu','Goro','Hachiuma','Haro','Haru',
  'Harujiro','Haruka','Hideaki','Hideo','Hiro','Hiromasa','Hiroshi','Ichiro',
  'Ietaka','Ike','Iku','Isamu','Isas','Ishi','Ishio','Isoroku','Izumi','Jien',
  'Jiro','Joji','Jun','Junichi','Kaito','Kamenosuke','Kane','Kanji',
  'Katsutoshi','Kazu','Ken','Kenichi','Kenji','Kenta','Kenzo','Kin','Kinshiro',
  'Kiosho','Kita','Kiyoshi','Kobo','Koichi','Koji','Koki','Kouhei','Kumakichi',
  'Masahiro','Masajun','Masashi','Masato','Masayoshi','Minoru','Nagataka',
  'Naoko','Naoki','Noboru','Nobu','Ren','Rikio','Riku','Ringo','Ryouichi',
  'Ryouta','Ryuu','Seiji','Sen','Shigeru','Shin','Shinjiro','Shouji','Shouhei',
  'Shunshi','Shunsuke','Shuzo','Souta','Susumu','Tadashi','Takehiro','Takeshi',
  'Takumi','Takuya','Tani','Taro','Tasou','Tatsuru','Tatsuya','Tetsuo',
  'Tobikuma','Tokujiro','Toshi','Toyohisa','Tsubasa','Tsutomu','Umi','Yasahiro',
  'Yasos','Yasuo','Yukio','Yutaka','Zen','Zero',
] as const;

export const FEMALE_FIRST_NAMES = [
  'Aisa','Aishun','Akako','Akae','Akane','Akemi','Akeno','Beni','Chiaki',
  'Chinatsu','Choyo','Eho','Hana','Harue','Harui','Hirari','Ino','Inoue',
  'Iori','Ito','Itsuko','Jori','Joruri','Jun','Junka','Kae','Kagami','Kagome',
  'Kaho','Kahori','Kahoru','Kana','Kanae','Kukiko','Kuma','Kyoumi','Leiko',
  'Machi','Mai','Mami','Manami','Mari','Mio','Mizuko','Moanna','Moe','Momoko',
  'Morie','Moto','Nishie','Nori','Noriko','Nui','Nyoko','Ochiyo','Oharu','Oki',
  'Okichi','Ori','Orie','Orika','Orimi','Osami','Poemu','Raiko','Raira','Raku',
  'Rakuko','Risu','Ritsuko','Roku','Rokuko','Romi','Rui','Ruka','Ruri',
  'Ruriko','Ruru','Ryouko','Ryu','Sachi','Sachiko','Sada','Sai','Sako','Sae',
  'Sayo','Sakura','Sato','Satsue','Sukie','Sumi','Tani','Taru','Tatsu','Tetsu',
  'Toki','Umika','Una','Wakiko','Wako','Wayoko','Wazuka','Yachi','Yae','Yaeko',
  'Yufu','Yui','Yuiha','Yuka','Yukaho','Yumisa','Yuna','Yuno','Chiesa','Lain',
  'Arisu',
] as const;

export const LAST_NAMES = [
  'Furude','Houjou','Sonozaki','Tohno','Ryuugu','Nagato','Asahina','Suzumiya',
  'Nakamura','Kobayashi','Saito','Tanaka','Watanabe','Takahashi','Ito',
  'Yamamoto','Sasaki','Seta','Hayashi','Kimura','Mori','Maeda','Endo','Miura',
  'Matsuda','Nakagawa','Yagami','Tenma','Osaka','Rando','Kawada','Sugimura',
  'Tachibana','Kimiji','Nanahara','Kotohiki','Liebert','Saeki','Saginomiya',
  'Kiriyama','Mimura','Matsui','Mido','Chigusa','Aizawa','Sunderland','Phoenix',
  'Amane','Asagami','Ryogi','Yumizuka','Uryu','Ayasaki','Emiya','Katsura',
  'Kijima','Nishizawa','Nonohara','Takamachi','Kira','Komuro','Washizu','Mudo',
  'Andou','Ishida','Busujima','Hirano','Takagi','Amano','Itou','Hideki',
  'Takana','Suzuki','Meguruno','Ushiromiya','Gasai','Kurisu','Rintarou',
  'Mayuri','Katsuragi','Yuzuru','Prescott','Yura','Mishiba','Atta','Etsu',
  'Minami',
] as const;

/**
 * Hair options paired with an atlas overlay id (the sprite shape) and a
 * color word (which drives both the displayName label and the runtime
 * tint applied to the grayscale sprite). Sprite shapes are reused across
 * colors — players still tell each other apart by colour first.
 *
 * Each gender carries the same 22-colour palette, so the (gender, color)
 * unique pool is 44 combos — well over MAX_PLAYERS = 22.
 */
interface HairOption {
  color: string;
  hairId: string;
}

// Distinct, easily-named colors. Lists are independent so each gender
// can vary the underlying sprite shape between colors.
const MALE_HAIR_BASES = [
  'BlackBoyHair', 'BlueBoyHair', 'BlueBoyHair2', 'BlueBoyHair3',
  'BrownBoyHair', 'GrayBoyHair', 'GreenBoyHair', 'OrangeBoyHair',
  'PurpleBoyHair', 'RedBoyHair', 'RedBoyHair2',
] as const;
const FEMALE_HAIR_BASES = [
  'BlackGirlHair', 'BlackGirlHair2', 'BlondeGirlHair', 'BlondeGirlHair2',
  'BlueGirlHair', 'BlueGirlHair2', 'BrownGirlHair', 'BrownGirlHair2',
  'GreenGirlHair', 'GreenGirlHair2', 'OrangeGirlHair', 'PinkGirlHair',
  'PinkGirlHair2', 'PurpleGirlHair', 'PurpleGirlHair2', 'RedGirlHair',
  'SilverGirlHair', 'SilverGirlHair2', 'WhiteGirlHair', 'WhiteGirlHair2',
] as const;

const COLORS = [
  'black', 'white', 'silver', 'gray', 'blonde', 'yellow', 'amber', 'orange',
  'red', 'crimson', 'pink', 'magenta', 'brown', 'chestnut', 'green', 'lime',
  'mint', 'teal', 'cyan', 'blue', 'navy', 'purple', 'lavender',
] as const;

const MALE_COLOR_TO_HAIR: ReadonlyArray<HairOption> = COLORS.map((color, i) => ({
  color,
  hairId: MALE_HAIR_BASES[i % MALE_HAIR_BASES.length] as string,
}));
const FEMALE_COLOR_TO_HAIR: ReadonlyArray<HairOption> = COLORS.map((color, i) => ({
  color,
  hairId: FEMALE_HAIR_BASES[i % FEMALE_HAIR_BASES.length] as string,
}));

export type Gender = 'male' | 'female';

export interface Demographics {
  gender: Gender;
  hairId: string;
  hairColor: string;
  realName: string;
  displayName: string;
}

function pick<T>(arr: ReadonlyArray<T>, rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)] as T;
}

/** Cosmetic display name shown in lieu of the real one — Death Note safe. */
export function displayNameFor(gender: Gender, hairColor: string): string {
  // High-school setting: "Boy" / "Girl" reads more in-fiction than the
  // clinical "Male" / "Female" labels. Color alone disambiguates because
  // we ship 22 distinct named colors per gender (44 unique labels).
  const noun = gender === 'male' ? 'Boy' : 'Girl';
  return `${noun} with ${hairColor} hair`;
}

/**
 * Roll an anonymous student identity for a fresh round. Real name is drawn
 * from the BYOND name pools so Death Note has a target to write; display
 * name only mentions sex + hair color so other players have to learn names
 * by playing.
 */
export function rollDemographics(rand: () => number = Math.random): Demographics {
  const gender: Gender = rand() < 0.5 ? 'male' : 'female';
  const palette = gender === 'male' ? MALE_COLOR_TO_HAIR : FEMALE_COLOR_TO_HAIR;
  const { color, hairId } = pick(palette, rand);
  // First-name-only — easier to read in chat / Death Note picker, and the
  // pool (~140 male + ~117 female firsts) is plenty for a 22-player room.
  const first = pick(gender === 'male' ? MALE_FIRST_NAMES : FEMALE_FIRST_NAMES, rand);
  return {
    gender,
    hairId,
    hairColor: color,
    realName: first,
    displayName: displayNameFor(gender, color),
  };
}

/**
 * Roll demographics that don't collide with any already-taken (gender, color)
 * pair OR real name. The (gender, color) pool has 16 entries (8 male + 8
 * female) — beyond that we have to allow display-name duplicates, but
 * real names always stay unique (95 lasts × 100+ firsts = 10k+ combos).
 */
export function rollUniqueDemographics(
  used: ReadonlyArray<Demographics>,
  rand: () => number = Math.random,
): Demographics {
  const usedDisplay = new Set(used.map((d) => d.displayName));
  const usedReal = new Set(used.map((d) => d.realName));
  const totalPairs = MALE_COLOR_TO_HAIR.length + FEMALE_COLOR_TO_HAIR.length;
  for (let i = 0; i < 200; i++) {
    const d = rollDemographics(rand);
    if (usedReal.has(d.realName)) continue;
    if (usedDisplay.size < totalPairs && usedDisplay.has(d.displayName)) continue;
    return d;
  }
  // Fallback: return whatever, even if it collides — should be extremely rare.
  return rollDemographics(rand);
}

/** Sanity reference for the client: which hair ids correspond to which colors. */
export const HAIR_COLOR_OPTIONS = {
  male: MALE_COLOR_TO_HAIR,
  female: FEMALE_COLOR_TO_HAIR,
} as const;

// Used by tests / lint to confirm the palettes line up with the sprite atlas.
const _maleHairs = new Set(HAIR_OPTIONS_MALE);
const _femaleHairs = new Set(HAIR_OPTIONS_FEMALE);
for (const m of MALE_COLOR_TO_HAIR) {
  if (!_maleHairs.has(m.hairId as (typeof HAIR_OPTIONS_MALE)[number])) {
    throw new Error(`names.ts male hairId ${m.hairId} missing from sprites.ts`);
  }
}
for (const f of FEMALE_COLOR_TO_HAIR) {
  if (!_femaleHairs.has(f.hairId as (typeof HAIR_OPTIONS_FEMALE)[number])) {
    throw new Error(`names.ts female hairId ${f.hairId} missing from sprites.ts`);
  }
}
