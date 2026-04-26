import StartGame from './game/main';
import { connectAnonymous } from './net/nakamaClient';

const NAKAMA_CONFIG = {
  serverKey: import.meta.env.VITE_NAKAMA_KEY ?? 'defaultkey',
  host: import.meta.env.VITE_NAKAMA_HOST ?? '127.0.0.1',
  port: Number(import.meta.env.VITE_NAKAMA_PORT ?? 7350),
  useSSL: (import.meta.env.VITE_NAKAMA_USE_SSL ?? 'false') === 'true',
};

document.addEventListener('DOMContentLoaded', () => {
  StartGame('game-container');

  connectAnonymous(NAKAMA_CONFIG)
    .then((conn) => {
      // M0 demo signal: a clean connect prints to the console.
      console.log(
        `[pyrce] connected: userId=${conn.userId} username=${conn.username} protocol=${conn.protocolVersion}`,
      );
      window.dispatchEvent(new CustomEvent('pyrce:connected', { detail: conn }));
    })
    .catch((err: unknown) => {
      console.error('[pyrce] failed to connect to nakama', err);
      window.dispatchEvent(new CustomEvent('pyrce:connect-error', { detail: err }));
    });
});
