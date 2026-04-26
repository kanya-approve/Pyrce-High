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

  // ===== Server → Client =====
  S2C_HELLO = 2000,
  S2C_ERROR = 2001,
}
