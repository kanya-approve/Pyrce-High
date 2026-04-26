import { Client, type Session } from '@heroiclabs/nakama-js';
import { WIRE_PROTOCOL_VERSION } from '@pyrce/shared';

const STORAGE_DEVICE_ID = 'pyrce.deviceId';
const STORAGE_TOKEN = 'pyrce.token';
const STORAGE_REFRESH = 'pyrce.refresh';

function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(STORAGE_DEVICE_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_DEVICE_ID, id);
  }
  return id;
}

function loadStoredSession(client: Client): Session | null {
  const token = localStorage.getItem(STORAGE_TOKEN);
  const refresh = localStorage.getItem(STORAGE_REFRESH);
  if (!token || !refresh) return null;
  try {
    const restored =
      client.constructor.prototype.constructor === Client
        ? (
            Client as unknown as { Session: { restore(t: string, r: string): Session } }
          ).Session.restore(token, refresh)
        : null;
    return restored;
  } catch {
    return null;
  }
}

function persistSession(session: Session): void {
  localStorage.setItem(STORAGE_TOKEN, session.token);
  if (session.refresh_token) {
    localStorage.setItem(STORAGE_REFRESH, session.refresh_token);
  }
}

export interface NakamaConfig {
  serverKey: string;
  host: string;
  port: number;
  useSSL: boolean;
}

export interface ConnectedSession {
  client: Client;
  session: Session;
  userId: string;
  username: string;
  protocolVersion: string;
}

export async function connectAnonymous(cfg: NakamaConfig): Promise<ConnectedSession> {
  const client = new Client(cfg.serverKey, cfg.host, String(cfg.port), cfg.useSSL);

  let session = loadStoredSession(client);
  if (session && !session.isexpired(Date.now() / 1000)) {
    // Session still valid — refresh in background if close to expiry, but use as-is now.
  } else {
    const deviceId = getOrCreateDeviceId();
    session = await client.authenticateDevice(deviceId, true);
    persistSession(session);
  }

  return {
    client,
    session,
    userId: session.user_id ?? '',
    username: session.username ?? '',
    protocolVersion: WIRE_PROTOCOL_VERSION,
  };
}
