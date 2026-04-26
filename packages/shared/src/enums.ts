/**
 * Shared enums used across client and server.
 *
 * Direction uses DM-compatible bitmask values (NORTH=1, SOUTH=2, EAST=4, WEST=8)
 * to ease porting from the BYOND source where direction math is bit-twiddled.
 */
export enum MatchPhase {
  Lobby = 'lobby',
  CharSelect = 'char_select',
  Starting = 'starting',
  InGame = 'in_game',
  Ending = 'ending',
}

export enum Direction {
  North = 1,
  South = 2,
  East = 4,
  West = 8,
  Northeast = 5, // North | East
  Northwest = 9, // North | West
  Southeast = 6, // South | East
  Southwest = 10, // South | West
}

export enum ChatChannel {
  Say = 'say',
  Whisper = 'whisper',
  Shout = 'shout',
  Emote = 'emote',
  OOC = 'ooc',
  Dead = 'dead',
  Shinigami = 'shinigami',
  Ghost = 'ghost',
  Watcher = 'watcher',
}

export enum HotkeySlot {
  Slot1 = 1,
  Slot2 = 2,
  Slot3 = 3,
  Slot4 = 4,
  Slot5 = 5,
}
