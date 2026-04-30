# Pyrce High

A web-first TypeScript rewrite of the BYOND/Dream Maker murder-mystery game
*Pyrce High*. Players join a lobby, get assigned hidden roles, hunt or hide,
and the round ends at sunrise.

- **Client:** Phaser 4 + Vite + TypeScript
- **Server:** [Nakama](https://heroiclabs.com/nakama) with TypeScript runtime
  modules bundled by Rollup
- **Shared package:** typed opcodes, wire-protocol payloads, content
  registries (items, roles, modes, tilemap)
- **Deploy:** Kubernetes-ready Helm chart (planned), Vite-built static client
  for any CDN

The original DM source lives in git history at commit `4a330e8` for any
reference needs (`git show 4a330e8:"<file>"`). It is no longer in the working
tree — the rewrite has full coverage of every gameplay verb and object that
isn't explicitly out of v1 scope (see [`TODO.md`](./TODO.md)).

## Layout

```
packages/
  shared/   @pyrce/shared   types, opcodes, content schemas
  server/   @pyrce/server   Nakama runtime modules (Rollup → dist/index.js)
  client/   @pyrce/client   Phaser 4 + Vite browser app

tools/
  dm-to-tiled/              .dmm map → JSON tilemap converter
  dmi-extract/              .dmi sprite atlas → PNG + frame manifest
  smoke/                    end-to-end smoke tests (m4–m7, browser puppeteer)

infra/
  docker-compose.yml        local Postgres + Nakama
  docker-compose.prod.yml   prod compose target
  nakama/                   nakama config

assets/dmi-source/          sprite source (input to tools/dmi-extract)

TODO.md                     deferred / declined work, with re-implementation hints
```

## Quick start

Prereqs: Node 22, pnpm 10, Docker (or Podman with the docker shim).

```bash
# 1. Install
pnpm install

# 2. Build the server bundle so Nakama has a module to load
pnpm --filter @pyrce/server build

# 3. Start Postgres + Nakama
docker compose -f infra/docker-compose.yml up -d

# 4. Start the Vite dev client (separate terminal)
pnpm --filter @pyrce/client dev
```

Open <http://localhost:8080>. The browser console should print:

```
[pyrce] connected: userId=… username=… protocol=…
```

Two browser tabs (use private windows so each gets its own device id) can
create / join lobbies, vote a mode, and play a full round.

## Useful commands

| Command | Effect |
|---|---|
| `pnpm install` | install all workspace deps |
| `pnpm typecheck` | `tsc --noEmit` across packages + tools |
| `pnpm lint` | biome check |
| `pnpm format` | biome format --write |
| `pnpm build` | build everything (shared → server → client) |
| `pnpm --filter @pyrce/shared build` | rebuild typed shared bundle |
| `pnpm --filter @pyrce/server build` | re-bundle the Nakama module |
| `pnpm --filter @pyrce/server dev` | Rollup watch on the server module |
| `pnpm --filter @pyrce/client dev` | Vite dev server (port 8080) |
| `pnpm --filter @pyrce/client build` | Vite production build |
| `docker compose -f infra/docker-compose.yml up -d` | Postgres + Nakama |
| `docker compose -f infra/docker-compose.yml down -v` | wipe local state |
| `docker restart pyrce-nakama` | reload server bundle after rebuild |

## Smoke tests

End-to-end smokes drive a real Nakama match against the running stack.

```bash
node tools/smoke/m5.mjs        # full Normal-mode round, role assignment, win check
node tools/smoke/m6.mjs        # chat audience routing
node tools/smoke/m7.mjs        # door + equipped-item fx hooks
node tools/smoke/browser.mjs http://localhost:8080/   # puppeteer client smoke
```

`m4.mjs` (combat + body discovery) is mode-RNG-flaky — see TODO.md.

## Architecture notes

### Server: Nakama TypeScript runtime
`packages/server/src/main.ts` registers the `pyrce_room` match handler
(`packages/server/src/matches/pyrceRoom.ts`) plus a small set of RPCs
(`packages/server/src/rpc/`). Rollup bundles to a single `dist/index.js`;
no Node built-ins, no `setTimeout` (Goja runtime).

The match handler uses a plain mutable `PyrceMatchState` (typed in
`packages/server/src/matches/state.ts`). Every state change that should be
visible to a client is broadcast manually — there is no Colyseus-style
auto-state-diff. Hidden state (roles, doppelganger disguise) is stripped
via `toPublicPlayerInGame()` before any non-self broadcast.

Per-tick scheduled effects (witch revives, death-note timers, vampire
hunger, sprint stamina drain, slow expiry, etc.) are kept in arrays /
maps on the state object and drained in `matchLoop`.

### Client: Phaser scene model
`packages/client/src/game/scenes/`:
- `Boot` / `Preload` / `MainMenu` — boot path, atlas + audio preload
- `LobbyBrowser` — list/create matches via Nakama RPC
- `Lobby` — joined-match player list, mode-vote, host Start button
- `GameWorld` — gameplay scene; tilemap, players, items, corpses, doors,
  lighting, input
- `Hud` — persistent overlay; HP/stamina, hotkey bar, status icons
- `ChatOverlay` — DOM `<input>` chat with proximity bubbles
- `Lighting` — Phaser BitmapMask radial light overlay
- `EndScene` — round-end reveal screen

`NakamaMatchClient` (`packages/client/src/net/matchClient.ts`) fans out
match-data and presence events to a `Set` of listeners so multiple scenes
can coexist (Lobby + ChatOverlay, GameWorld + ChatOverlay, etc).

### Shared package
- `opcodes.ts` — single source of truth for the wire protocol
- `wire/match.ts` + `wire/inventory.ts` — payload types for each opcode
- `content/items.ts`, `roles.ts`, `modes.ts` — content registries
- `content/tilemap/default.json` — converted DM map (output of
  `tools/dm-to-tiled/`)

## Status

The v1 milestone scope (M0 → M7) is functionally complete. The following
have all been implemented since the original plan:

- All 11 game modes (Normal, Vampire, Witch, Zombie, Doppelganger, Secret,
  Extended, Death Note, Death Note Classic, Ghost, Slender)
- Combat with evade / face-to-face crit / behind-target glance
- Bleed, KO, freeze (feather), sedative-slow status timers
- Body discovery + suspect-description variant
- Search-consent flow + plant-on-body framing
- Vote-kick, vote-end-game, vote-mode
- Lobby chat + in-game proximity chat (Say/Whisper/Shout/Emote/OOC/Dead/
  Ghost/Shini)
- Day/night clock + lighting + time-of-day tint
- Containers (look + take + put + push), drawers, lockers, fridge, vending
- Doors (regular, locked-with-keycard, escape-with-keycard)
- Steel Door escape with town-survival win condition
- Wash blood at sinks
- Sprint (Shift) with stamina drain
- Shove (X), Plant on body (M), Container push (Y), Corpse push (O)
- Anonymous PDA-to-PDA SMS
- Class-roster classroom assignment

What remains is in [`TODO.md`](./TODO.md) — deferred polish, host options,
NPC AI for Slender / NPC-zombie variant, alternate map, profile +
stats persistence, and the production deploy story (Helm + Sentry +
Prometheus).

## v1 design decisions (locked)

- **Auth:** anonymous device id only. UUID in `localStorage`,
  `client.authenticateDevice`. No social login, no email/password.
- **Migration:** clean cut from BYOND. No `world.sav` import.
- **Maps:** `Default.dmm` only.
- **Modes:** all data-driven via `GameModeDef`; new modes are
  content-only PRs.
