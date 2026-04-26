import StartGame from './game/main';
import { NakamaMatchClient } from './net/matchClient';
import { connectAnonymous } from './net/nakamaClient';

const NAKAMA_CONFIG = {
  serverKey: import.meta.env.VITE_NAKAMA_KEY ?? 'defaultkey',
  host: import.meta.env.VITE_NAKAMA_HOST ?? '127.0.0.1',
  port: Number(import.meta.env.VITE_NAKAMA_PORT ?? 7350),
  useSSL: (import.meta.env.VITE_NAKAMA_USE_SSL ?? 'false') === 'true',
};

document.addEventListener('DOMContentLoaded', () => {
  const game = StartGame('game-container');

  connectAnonymous(NAKAMA_CONFIG)
    .then((conn) => {
      const matchClient = new NakamaMatchClient(conn.client, conn.socket, conn.session);
      game.registry.set('match', matchClient);
      console.log(
        `[pyrce] connected: userId=${conn.userId} username=${conn.username} protocol=${conn.protocolVersion}`,
      );
      window.dispatchEvent(new CustomEvent('pyrce:connected', { detail: matchClient }));
    })
    .catch((err: unknown) => {
      console.error('[pyrce] failed to connect to nakama', err);
      window.dispatchEvent(new CustomEvent('pyrce:connect-error', { detail: err }));
    });
});
