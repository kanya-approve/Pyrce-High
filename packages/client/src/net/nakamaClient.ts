import { Client, Session, type Socket } from '@heroiclabs/nakama-js';
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

function loadStoredSession(): Session | null {
  const token = localStorage.getItem(STORAGE_TOKEN);
  const refresh = localStorage.getItem(STORAGE_REFRESH);
  if (!token || !refresh) return null;
  try {
    return Session.restore(token, refresh);
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
  socket: Socket;
  session: Session;
  userId: string;
  username: string;
  protocolVersion: string;
}

/**
 * Authenticate (anonymous device auth, persists across reloads), then open a
 * realtime socket. Resolves once the socket is connected.
 */
export async function connectAnonymous(cfg: NakamaConfig): Promise<ConnectedSession> {
  const client = new Client(cfg.serverKey, cfg.host, String(cfg.port), cfg.useSSL);

  let session = loadStoredSession();
  const nowSec = Date.now() / 1000;
  if (!session || session.isexpired(nowSec)) {
    const deviceId = getOrCreateDeviceId();
    session = await client.authenticateDevice(deviceId, true);
  }
  persistSession(session);

  const socket = client.createSocket(cfg.useSSL, false /* verbose */);
  await socket.connect(session, true /* appearOnline */);

  return {
    client,
    socket,
    session,
    userId: session.user_id ?? '',
    username: session.username ?? '',
    protocolVersion: WIRE_PROTOCOL_VERSION,
  };
}

/** Drop the cached session — next connect will re-authenticate fresh. */
export function clearStoredSession(): void {
  localStorage.removeItem(STORAGE_TOKEN);
  localStorage.removeItem(STORAGE_REFRESH);
}
