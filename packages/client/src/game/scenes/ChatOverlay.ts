import { ChatChannel, OpCode, type S2CChatMessage, type S2CTyping } from '@pyrce/shared';
import { Scene } from 'phaser';
import type { NakamaMatchClient } from '../../net/matchClient';

const HISTORY_LIMIT = 12;
const BUBBLE_DURATION_MS = 3500;

interface ChatLine {
  channel: ChatChannel;
  fromUsername: string;
  body: string;
}

interface ParsedInput {
  channel: ChatChannel;
  body: string;
}

const CHANNEL_PREFIXES: Record<string, ChatChannel> = {
  '/shout': ChatChannel.Shout,
  '/whisper': ChatChannel.Whisper,
  '/w': ChatChannel.Whisper,
  '/ooc': ChatChannel.OOC,
  '/emote': ChatChannel.Emote,
  '/me': ChatChannel.Emote,
  '/dead': ChatChannel.Dead,
};

const CHANNEL_COLOURS: Partial<Record<ChatChannel, string>> = {
  [ChatChannel.Say]: '#ffffff',
  [ChatChannel.Whisper]: '#aaccff',
  [ChatChannel.Shout]: '#ff8866',
  [ChatChannel.Emote]: '#bb88ff',
  [ChatChannel.OOC]: '#88cc88',
  [ChatChannel.Dead]: '#888888',
  [ChatChannel.Ghost]: '#bbbbff',
  [ChatChannel.Shinigami]: '#ffaa55',
};

/**
 * Persistent chat overlay scene. A real `<input>` element is mounted to the
 * game-container DOM (not Phaser-managed) so we get native IME + selection.
 * Slash prefixes pick the channel; default is `say`.
 *
 * Bubble-worthy messages emit a 'chat:bubble' event on the global registry
 * so the GameWorld scene can pop a 3.5s text balloon over the speaker.
 */
export class ChatOverlay extends Scene {
  private match!: NakamaMatchClient;
  private history: ChatLine[] = [];
  private historyText!: Phaser.GameObjects.Text;
  private inputEl!: HTMLInputElement;
  private inputContainer!: HTMLDivElement;

  constructor() {
    super('ChatOverlay');
  }

  create(): void {
    this.match = this.game.registry.get('match') as NakamaMatchClient;
    const { height } = this.scale.gameSize;

    this.historyText = this.add
      .text(12, height - 168, '', {
        fontFamily: 'Courier New',
        fontSize: 13,
        color: '#dddddd',
        backgroundColor: '#000000aa',
        padding: { left: 6, right: 6, top: 4, bottom: 4 },
        wordWrap: { width: 440 },
      })
      .setOrigin(0, 1)
      .setScrollFactor(0)
      .setDepth(1500);

    this.add
      .text(12, height - 14, 'press T or Enter to chat · /shout /whisper /ooc /emote /dead', {
        fontFamily: 'Arial',
        fontSize: 11,
        color: '#888888',
        backgroundColor: '#000000aa',
        padding: { left: 6, right: 6, top: 2, bottom: 2 },
      })
      .setOrigin(0, 1)
      .setScrollFactor(0)
      .setDepth(1500);

    this.buildInputElement();

    if (this.input.keyboard) {
      this.input.keyboard.on('keydown-T', (ev: KeyboardEvent) => {
        if (document.activeElement === this.inputEl) return;
        ev.preventDefault();
        this.focusInput();
      });
      this.input.keyboard.on('keydown-ENTER', (ev: KeyboardEvent) => {
        if (document.activeElement === this.inputEl) return;
        ev.preventDefault();
        this.focusInput();
      });
      this.input.keyboard.on('keydown-SLASH', (ev: KeyboardEvent) => {
        if (document.activeElement === this.inputEl) return;
        ev.preventDefault();
        this.inputEl.value = '/';
        this.focusInput();
      });
    }

    this.match.onMatchData((msg) => {
      if (msg.op_code === OpCode.S2C_CHAT_MESSAGE) {
        const m = parsePayload<S2CChatMessage>(msg.data);
        if (m) this.handleChatMessage(m);
      } else if (msg.op_code === OpCode.S2C_TYPING) {
        const t = parsePayload<S2CTyping>(msg.data);
        if (t) this.game.events.emit('chat:typing', t);
      }
    });
  }

  shutdown(): void {
    this.match.onMatchData(() => {});
    this.inputContainer?.remove();
  }

  // ---------- input handling ----------

  private buildInputElement(): void {
    const parent = this.game.canvas.parentElement;
    if (!parent) return;
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.left = '12px';
    container.style.bottom = '34px';
    container.style.width = '440px';
    container.style.display = 'none';
    container.style.zIndex = '2000';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = 'say… (/shout /whisper /ooc /emote /dead)';
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.padding = '6px 8px';
    input.style.fontFamily = 'Arial, sans-serif';
    input.style.fontSize = '14px';
    input.style.color = '#ffffff';
    input.style.background = 'rgba(0, 0, 0, 0.65)';
    input.style.border = '1px solid #88aaff';
    input.style.outline = 'none';
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.submit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.blurInput();
      }
    });
    // istyping: emit BEGIN once the user has typed >4 chars (matches DM
    // behaviour). Emit END on blur/submit/clear.
    input.addEventListener('input', () => this.maybeEmitTyping());
    container.appendChild(input);
    parent.appendChild(container);
    this.inputEl = input;
    this.inputContainer = container;
  }

  private focusInput(): void {
    this.inputContainer.style.display = 'block';
    this.inputEl.focus();
    if (this.input.keyboard) this.input.keyboard.enabled = false;
  }

  private blurInput(): void {
    this.endTyping();
    this.inputEl.value = '';
    this.inputContainer.style.display = 'none';
    this.inputEl.blur();
    if (this.input.keyboard) this.input.keyboard.enabled = true;
    this.game.canvas.focus();
  }

  private submit(): void {
    const raw = this.inputEl.value.trim();
    if (raw.length === 0) {
      this.blurInput();
      return;
    }
    const parsed = this.parseInput(raw);
    void this.match.sendMatch(OpCode.C2S_CHAT, parsed);
    this.blurInput();
  }

  private typingActive = false;
  private typingChannel: ChatChannel = ChatChannel.Say;

  /** Emit C2S_TYPING_BEGIN once after >4 chars; END when cleared/sent. */
  private maybeEmitTyping(): void {
    const raw = this.inputEl.value;
    const parsed = this.parseInput(raw.trim());
    const longEnough = parsed.body.length > 4;
    if (longEnough && !this.typingActive) {
      this.typingActive = true;
      this.typingChannel = parsed.channel;
      void this.match.sendMatch(OpCode.C2S_TYPING_BEGIN, { channel: parsed.channel });
    } else if (!longEnough && this.typingActive) {
      this.endTyping();
    } else if (this.typingActive && parsed.channel !== this.typingChannel) {
      // Channel switched mid-type (e.g. they added a /shout prefix); resync.
      void this.match.sendMatch(OpCode.C2S_TYPING_END, { channel: this.typingChannel });
      void this.match.sendMatch(OpCode.C2S_TYPING_BEGIN, { channel: parsed.channel });
      this.typingChannel = parsed.channel;
    }
  }

  private endTyping(): void {
    if (!this.typingActive) return;
    this.typingActive = false;
    void this.match.sendMatch(OpCode.C2S_TYPING_END, { channel: this.typingChannel });
  }

  private parseInput(raw: string): ParsedInput {
    if (raw.startsWith('/')) {
      const space = raw.indexOf(' ');
      const prefix = (space === -1 ? raw : raw.slice(0, space)).toLowerCase();
      const channel = CHANNEL_PREFIXES[prefix];
      if (channel) {
        return { channel, body: space === -1 ? '' : raw.slice(space + 1).trim() };
      }
    }
    return { channel: ChatChannel.Say, body: raw };
  }

  // ---------- inbound rendering ----------

  private handleChatMessage(m: S2CChatMessage): void {
    this.history.push({ channel: m.channel, fromUsername: m.fromUsername, body: m.body });
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
    this.renderHistory();
    if (m.bubble) {
      this.game.events.emit('chat:bubble', {
        userId: m.fromUserId,
        body: m.body,
        channel: m.channel,
        durationMs: BUBBLE_DURATION_MS,
      });
    }
  }

  private renderHistory(): void {
    const lines = this.history.map((line) => formatLine(line));
    this.historyText.setText(lines.join('\n'));
  }
}

function formatLine(line: ChatLine): string {
  switch (line.channel) {
    case ChatChannel.Emote:
      return `* ${line.fromUsername} ${line.body}`;
    case ChatChannel.Shout:
      return `${line.fromUsername} SHOUTS: ${line.body}`;
    case ChatChannel.Whisper:
      return `${line.fromUsername} (whispering): ${line.body}`;
    case ChatChannel.OOC:
      return `[OOC] ${line.fromUsername}: ${line.body}`;
    case ChatChannel.Dead:
      return `[dead] ${line.fromUsername}: ${line.body}`;
    case ChatChannel.Ghost:
      return `[ghost] ${line.fromUsername}: ${line.body}`;
    case ChatChannel.Shinigami:
      return `[shini] ${line.fromUsername}: ${line.body}`;
    default:
      return `${line.fromUsername}: ${line.body}`;
  }
}

function parsePayload<T>(data: string | Uint8Array): T | null {
  const raw = typeof data === 'string' ? data : new TextDecoder().decode(data);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// Re-export the channel colour map for any other scenes that want to render
// bubbles in the same palette.
export { CHANNEL_COLOURS };
