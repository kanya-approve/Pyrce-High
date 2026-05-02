/**
 * Chat wire payloads. Channel ranges follow the DM source `Verbs.dm` —
 * say(8), whisper(4), shout(35), emote(8) — and special-channel
 * visibility (OOC/dead/ghost/shini) is enforced server-side.
 *
 * `S2CChatMessage` is what hits the chat UI; `bubble: true` also drives
 * the over-head chat bubble in the GameWorld scene.
 */
import type { ChatChannel } from '../enums.js';

export interface C2SChat {
  channel: ChatChannel;
  /** Trimmed and length-capped server-side. */
  body: string;
  /** Reserved for direct-target whispers; M6 uses proximity-based whisper. */
  targetUserId?: string;
}

export interface C2STypingBegin {
  channel: ChatChannel;
}
export interface C2STypingEnd {
  channel: ChatChannel;
}

export interface S2CChatMessage {
  channel: ChatChannel;
  fromUserId: string;
  /** Anonymous label of the sender ("Male with brown hair"). */
  fromDisplayName: string;
  body: string;
  /** Chat-bubble worthy (i.e. say/whisper/shout/emote). False for OOC / dead-chat etc. */
  bubble: boolean;
  /** Server tick at which the message was committed. */
  tickN: number;
}

export interface S2CTyping {
  fromUserId: string;
  channel: ChatChannel;
  active: boolean;
}
