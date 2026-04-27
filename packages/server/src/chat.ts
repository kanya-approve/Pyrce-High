/**
 * Chat routing. Channel ranges mirror the DM source `Verbs.dm`:
 *
 *   say     — Chebyshev 8  (alive, in range)
 *   whisper — Chebyshev 4  (alive, in range)
 *   shout   — Chebyshev 35 (alive, in range)
 *   emote   — Chebyshev 8  (alive, in range; body rendered as third-person)
 *   ooc     — everyone (alive + dead)
 *   dead    — only dead players (& watchers)
 *   ghost   — M5.x: ghost role + whisperer (M6 stub: dead-only)
 *   shini   — M5.x: shinigami role + eyes-deal recipients (M6 stub: dead-only)
 *
 * Body length is capped at 500 chars. Empty / whitespace-only bodies are
 * dropped silently.
 */

import { ChatChannel } from '@pyrce/shared';
import type { PlayerInGame, PyrceMatchState } from './matches/state.js';

export const CHANNEL_RANGES: Partial<Record<ChatChannel, number>> = {
  [ChatChannel.Say]: 8,
  [ChatChannel.Whisper]: 4,
  [ChatChannel.Shout]: 35,
  [ChatChannel.Emote]: 8,
};

export const MAX_BODY_LEN = 500;

export interface ChatRoute {
  /** Subset of presences that should receive the message. */
  recipients: nkruntime.Presence[];
  /** Whether the message is bubble-worthy (drives the over-head bubble). */
  bubble: boolean;
}

function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Return the list of presences that should receive `body` from `sender` on
 * `channel`. Sender is included if they qualify under the channel rule.
 */
export function routeChat(
  state: PyrceMatchState,
  sender: PlayerInGame,
  channel: ChatChannel,
): ChatRoute {
  const recipients: nkruntime.Presence[] = [];
  const range = CHANNEL_RANGES[channel];

  for (const userId in state.presences) {
    const pres = state.presences[userId];
    const player = state.players[userId];
    if (!pres || !player) continue;

    let include = false;
    switch (channel) {
      case ChatChannel.Say:
      case ChatChannel.Whisper:
      case ChatChannel.Shout:
      case ChatChannel.Emote:
        include = player.isAlive && range !== undefined && chebyshev(player, sender) <= range;
        break;
      case ChatChannel.OOC:
        include = true;
        break;
      case ChatChannel.Dead:
      case ChatChannel.Ghost:
      case ChatChannel.Shinigami:
      case ChatChannel.Watcher:
        // M6: only dead/spectating players see these. Mode-specific role
        // gating (Ghost / Shinigami / Watcher) lands in M5.x.
        include = !player.isAlive || player.isWatching;
        break;
    }

    if (include) recipients.push(pres);
  }

  const bubble =
    channel === ChatChannel.Say ||
    channel === ChatChannel.Whisper ||
    channel === ChatChannel.Shout ||
    channel === ChatChannel.Emote;
  return { recipients, bubble };
}

/** Trim and clamp incoming chat bodies. Returns empty string if invalid. */
export function sanitizeChatBody(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  return trimmed.slice(0, MAX_BODY_LEN);
}
