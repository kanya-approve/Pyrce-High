/**
 * Opcode catalog for the Nakama match data wire protocol.
 *
 * Convention:
 *   1xxx — client → server
 *   2xxx — server → client
 *   3xxx — bidirectional control
 *
 * Add codes here as milestones land. M0 only needs the handshake stubs.
 */
export enum OpCode {
  // ===== Control =====
  CTRL_HEARTBEAT = 3000,

  // ===== Client → Server =====
  C2S_PING = 1000,
  C2S_REQUEST_CATCHUP = 1001,

  C2S_LOBBY_VOTE_MODE = 1100,
  C2S_LOBBY_READY = 1101,
  C2S_LOBBY_START_GAME = 1102,
  C2S_LOBBY_KICK = 1103,

  C2S_MOVE_INTENT = 1300,

  // ===== Server → Client =====
  S2C_HELLO = 2000,
  S2C_ERROR = 2001,
  S2C_PHASE_CHANGE = 2002,

  S2C_LOBBY_STATE = 2100,
  S2C_LOBBY_VOTE_TALLY = 2101,
  S2C_LOBBY_PLAYER_JOIN = 2102,
  S2C_LOBBY_PLAYER_LEAVE = 2103,
  S2C_LOBBY_HOST_CHANGED = 2104,

  S2C_INITIAL_SNAPSHOT = 2300,
  S2C_PLAYER_MOVED = 2310,
}
