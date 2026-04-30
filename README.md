# Pyrce High

A web-first TypeScript rewrite of the BYOND/Dream Maker murder-mystery game
*Pyrce High*. Players join a lobby, get assigned hidden roles, hunt or hide,
and the round ends at sunrise.

| Layer | Stack |
|---|---|
| Client | Phaser 4 + Vite + TypeScript |
| Server | [Nakama](https://heroiclabs.com/nakama) TypeScript runtime modules, Rollup-bundled to a single `dist/index.js` |
| Shared | Typed opcodes, wire-protocol payloads, content registries |
| Tooling | pnpm workspaces · Biome (lint+format) · TypeScript 6 |
| Local dev | docker-compose (Postgres + Nakama) |

The original DM source lives in git history at commit `4a330e8` for any
reference needs (`git show 4a330e8:"<file>"`). It is no longer in the working
tree — the rewrite has full coverage of every gameplay verb and object that
isn't explicitly out of v1 scope. Deferred polish is logged in
[`TODO.md`](./TODO.md).

## Layout

```
packages/
  shared/        @pyrce/shared        types, opcodes, content schemas
  server/        @pyrce/server        Nakama runtime modules (Rollup → dist/index.js)
  client/        @pyrce/client        Phaser 4 + Vite browser app
  game-server/   @pyrce/game-server   Agones-managed dedicated game-server pod (Node + ws)

tools/
  smoke/                         end-to-end smoke tests (m4–m7, browser puppeteer)

infra/
  docker-compose.yml             local Postgres + Nakama
  docker-compose.prod.yml        prod compose target
  nakama/                        nakama config
  helm/pyrce-nakama/             Helm chart (Nakama Deployment), backed by bjw-s common
  helm/pyrce-client/             Helm chart (nginx + Vite bundle), backed by bjw-s common
  k8s/agones/                    Agones Fleet + FleetAutoscaler manifests for the
                                 realtime game-server tier (CRD-based, not Helm)

.github/workflows/
  ci.yml                         lint + typecheck + build + helm lint
  images.yml                     build + push pyrce-nakama / pyrce-client / pyrce-game-server
                                 images to ghcr.io/kanya-approve

TODO.md                          deferred / declined work, with re-implementation hints
```

## Architecture

Three deploy tiers:

```
                      ┌──────────────────────────────┐
                      │ pyrce-client (nginx + Vite)  │  Helm chart
                      │ Phaser 4 browser app         │
                      └─────────────┬────────────────┘
                                    │ WSS
                      ┌─────────────▼────────────────┐
                      │ pyrce-nakama                 │  Helm chart, sticky-cookie ingress
                      │ matchmaker / identity /      │
                      │ social / lobby / chat        │
                      └─────────────┬────────────────┘
                                    │ Agones Allocator API (mTLS)
                      ┌─────────────▼────────────────┐
                      │ pyrce-game-server            │  Agones Fleet + FleetAutoscaler
                      │ realtime round (movement,    │  one pod per match
                      │ combat, lighting, …)         │
                      └──────────────────────────────┘
```

In v1 the realtime round logic still lives in the Nakama match handler;
the `game-server` package is the migration target so future rounds can
run in Agones-managed dedicated pods. The `allocateGameServer` Nakama
RPC speaks to the Agones Allocator and returns an `address:port` to
matched clients — when the match handler migrates, the client just
follows the returned URL instead of staying on the Nakama match.

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
- `content/tilemap/default.json` — game tilemap (grid + objects)

## Default keybinds

| Key | Action |
|---|---|
| `WASD` / arrows | move |
| `Shift` (held) | sprint (drains stamina) |
| `T` / `Enter` | open chat |
| `E` | interact (door / vending / container / escape door) |
| `F` | attack in facing direction |
| `G` | drop equipped |
| `1` – `5` | hotkey equip / use |
| `I` | open inventory |
| `C` | craft (spear) |
| `H` | wash (at bathroom sink) |
| `X` | shove adjacent player |
| `Y` | push adjacent container |
| `O` | push adjacent corpse |
| `M` | plant equipped item on adjacent corpse / KO'd |
| `P` | drag adjacent corpse |
| `B` | doppelganger copy |
| `R` | vampire drain |
| `Q` | role ability (witch invisible-walk, vampire dash, …) |
| `V` | vote end game |
| `K` | open vote-kick picker |
| `L` | toggle adjacent light switch |
| `J` | view security tapes (at monitor) |
| `N` | cycle to next security camera (at monitor) |
| `Z` | delete tapes (killer-only, at monitor) |
| Right-click player | view profile |

`/suicide`, `/shini`, `/ghost`, `/whisper`, `/shout`, `/emote`, `/ooc`, `/dead`
work as chat-prefixes inside the chat box.

## Status

The v1 milestone scope (M0 → M7) is functionally complete. Recent work has
filled out the gameplay surface so it covers the BYOND source verbatim:

**Modes.** Normal, Vampire, Witch, Zombie, Doppelganger, Secret, Extended,
Death Note, Death Note Classic, Ghost, Slender (11 of 11).

**Combat.** Evade / face-to-face crit / behind-target glance rolls. Bleed,
KO, freeze (feather), sedative-slow status timers. Mystic Eyes (Nanaya's
Nanatsu-Yoru with glasses removed: 1% insta-kill / rand 1-33).

**Detective layer.** Body discovery + suspect-description variant. Search
-consent flow. Plant-on-body framing. Per-player bloody (0..8) overlay tier;
blood drips on movement. Security cameras + monitors with `View_Tapes`
hair-color forensics; `Delete_Tapes` killer-only counter.

**Environment.** Tile-step movement with warp-tile teleports (vents, stair
pairs). Doors (regular, locked-with-keycard, escape-with-keycard). Wash blood
at sinks. Steel Door escape with town-survival win condition. Light switches
(13 tagged areas) + dim overlay when lights are off. Containers (look + take +
put + push). Vending machines. Day/night clock + lighting + time-of-day tint.

**Social.** Lobby chat + in-game proximity chat (Say/Whisper/Shout/Emote/OOC/
Dead/Ghost/Shini). Vote-kick, vote-end-game, vote-mode. Anonymous PDA-to-PDA
SMS. Shinigami eye deal (offer / accept with scheduled death).

**Other.** Class-roster classroom assignment. Sprint, shove, plant, drag, push.
Watcher join. Vampire hunger. Witch butterflies. Dragon-style feather
projectile. Suicide, throw, door-code entry, paper write/airplane.

What remains is in [`TODO.md`](./TODO.md) — deferred polish, host options,
NPC-controlled Slender / Zombie variants, alternate map, profile +
stats persistence, and the production deploy story (Helm + Sentry +
Prometheus).

## v1 design decisions (locked)

- **Auth:** anonymous device id only. UUID in `localStorage`,
  `client.authenticateDevice`. No social login, no email/password.
- **Migration:** clean cut from BYOND. No `world.sav` import.
- **Maps:** `Default.dmm` only.
- **Modes:** all data-driven via `GameModeDef`; new modes are
  content-only PRs.
