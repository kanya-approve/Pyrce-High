# Pyrce High

A web-first rewrite of the BYOND/Dream Maker murder-mystery game *Pyrce High*.

- **Client:** Phaser 4 + Vite + TypeScript
- **Server:** [Nakama](https://heroiclabs.com/nakama) with TypeScript runtime modules
- **Shared:** typed wire protocol + content schemas
- **Deploy:** Kubernetes for the server, S3 + CloudFront for the static client

The legacy DM source remains in this repo at the top level (`*.dm`, `*.dmm`,
`Icons/`, `gfx/`, `audio/`, …) as the behavioral reference. Don't modify it.

## Layout

```
packages/
  shared/   @pyrce/shared    types, opcodes, content schemas
  server/   @pyrce/server    Nakama runtime modules (Rollup → single dist/index.js)
  client/   @pyrce/client    Phaser 4 + Vite browser app
infra/                      docker-compose for dev, Helm chart for prod (M8)
tools/                      one-off CLIs (dm-to-tiled, etc., M2+)
*.dm, *.dmm, ...            legacy DM source (read-only reference)
```

The full implementation plan lives at
`~/.claude/plans/rustling-sauteeing-pie.md`.

## Quick start

Prereqs: Node 22, pnpm 10, Docker.

```bash
# 1. Install dependencies
pnpm install

# 2. Build the server bundle so docker has something to mount
pnpm -F @pyrce/server build

# 3. Start Postgres + Nakama
docker compose -f infra/docker-compose.yml up

# 4. (Separate terminal) start the Vite client
pnpm -F @pyrce/client dev
```

Then open <http://localhost:8080> and check the browser console:

```
[pyrce] connected: userId=... username=... protocol=0.1.0
```

That's the M0 demo signal.

## Useful commands

| Command | Effect |
|---|---|
| `pnpm install` | install all workspace deps |
| `pnpm dev` | run all package dev servers in parallel |
| `pnpm dev:server` / `pnpm dev:client` | focused dev |
| `pnpm typecheck` | tsc across all packages |
| `pnpm lint` | biome check |
| `pnpm format` | biome format --write |
| `pnpm build` | build everything (shared → server bundle → client dist) |
| `pnpm -F @pyrce/server dev` | rollup --watch the server bundle |
| `docker compose -f infra/docker-compose.yml up` | local Nakama + Postgres |
| `docker compose -f infra/docker-compose.yml down -v` | wipe local Nakama state |

## Milestones

- [x] **M0** — Foundation: monorepo, Vite client boots, Rollup server bundle, Docker stack, CI.
- [ ] **M1** — Auth, profile, lobby browser
- [ ] **M2** — Tilemap render + tile-step movement + presence
- [ ] **M3** — Inventory, items, containers
- [ ] **M4** — Combat, HP, death, corpse, body discovery
- [ ] **M5** — Mode engine + Normal mode + win conditions + clock *(this is v1)*
- [ ] **M6** — Chat, emote, proximity audiences
- [ ] **M7** — Lighting, audio, persistence, polish
- [ ] **M8** — Production deploy, observability, CDN

## v1 scope (locked)

- Normal mode only (mode engine fully built; other modes are content-only PRs later)
- Anonymous device auth only (no social login in v1)
- Clean cut from BYOND (no `world.sav` migration)
- `Default.dmm` only (no `Default2.dmm` in v1)
