# `infra/` — local dev + production deployment

## Local dev

```bash
# 1. Build the server bundle so docker has something to mount.
pnpm -F @pyrce/server build

# 2. Start Postgres + Nakama.
docker compose -f infra/docker-compose.yml up

# 3. (In a separate terminal) start the client.
pnpm -F @pyrce/client dev
```

Then open <http://localhost:8080>. The browser console should print:

    [pyrce] connected: userId=… username=… protocol=0.1.0

## Watch mode for the server

```bash
# Terminal 1
pnpm -F @pyrce/server dev      # rollup --watch

# Terminal 2
docker compose -f infra/docker-compose.yml restart nakama   # after each rebuild
```

Nakama doesn't hot-reload runtime modules by default — a `restart` picks up
the new bundle. (If you need HMR, see the Nakama `--runtime.read_only_globals
false` flag, but it's brittle.)

## Useful URLs

| Service | URL |
|---|---|
| Nakama HTTP / WebSocket | `http://localhost:7350` |
| Nakama gRPC | `localhost:7349` |
| Nakama console (admin UI) | <http://localhost:7351> (admin / localdev) |
| Nakama Prometheus metrics | <http://localhost:9100/> |
| Postgres | `localhost:5432` (nakama / localdev / nakama) |

## Resetting state

```bash
docker compose -f infra/docker-compose.yml down -v
```

Deletes the postgres volume — wipes accounts, storage objects, match history.

## Production

See `infra/helm/pyrce/` (lands in M8).
