# Pyrce High — Deferred work

This file captures work that was deliberately scoped out of the v1 BYOND→TS
rewrite, plus DM-source features that have been declined for reasons noted
inline. Each entry is detailed enough to re-implement without re-auditing
the original `*.dm` source. Original DM source for any reference-needs
lives at git commit `4a330e8` (recover via `git show 4a330e8:"<file>"`).

Numbers (P1/P2/P3) describe player-impact, not implementation effort.

---

## Maps & content

### P2 — `Default2.dmm` second map
- DM has a second 200×200 map (`Default2.dmm`) used as an alternate venue.
- v1 ships `Default.dmm` only via `tools/dm-to-tiled/`.
- To add: re-run the converter on `Default2.dmm`, emit a second
  `packages/shared/src/content/tilemap/default2.json`, plumb a map id
  through `MatchState.mapId`, swap the `Tilemap` singleton in
  `packages/server/src/world/tilemap.ts` for a per-match instance.
  Lobby/match RPCs gain a `mapId` param. Likely 1–2 days.
- Reason deferred: single-map keeps the converter, lighting, spawn-id
  enums, and atlas pipeline simple for v1.

### P3 — Anime-name generator (`Player Names.dm`)
- DM rolls a fake name (Tohno, Furude, …) per player for in-round
  "real-name" reveals on death.
- Currently `realName` defaults to `username`. To add: ship a wordlist
  in `packages/shared/src/content/names.ts`, pick at `assignSpawns()`,
  store in `PlayerInGame.realName`. ~1h.
- Pure flavor; no gameplay change.

---

## Combat & movement extras

### P3 — School Uniform host toggle
- DM's `Hostfunctionuniform` swapped every player's torso sprite to a
  matching school-uniform variant.
- Cosmetic only. Would require a uniform overlay frame in the atlas
  pipeline and a `MatchState.uniformOn` flag.

### P3 — Tapes, multikey, key-card host toggles
- `Hostfunctiontapes` (drop tapes for spear crafting), `Hostfunctionmultikey`
  (allow 2+ keys per IP), `Hostfunctionescape` (toggle escape door).
- Tapes are already a craftable input; toggle would just gate loot tables.
  Multikey is anti-cheat related — re-evaluate with auth at v1.x.
  Escape is now wired (commit `44901da`); a host toggle would just gate
  the verb response.

---

## Hosting / admin

### P2 — Host options panel
- DM `HostingWorld.dm` + `Host_Options.dm` exposed: change-game-hours,
  change-mode-poll-delay, change-attack-delay, change-hoard-delay,
  change-lethality, change-spawn-rate, set-max-players, change-map.
- Currently the host can only Start the game. To add: an
  `RpcId.HostUpdateMatch` that mutates a `MatchState.config` object in
  Lobby phase only, with a host-only modal in `Lobby.ts`.
- Reason deferred: per-match tuning is a power-user feature; defaults
  cover 95% of rounds.

### P2 — Autohost / autopoll
- DM auto-rotated mode polls and auto-started rounds when ≥4 players
  joined. `Hosttoggleautohost` + `Hosttoggleautopoll`.
- To add: a tick-loop check in `matchLoop` when phase=Lobby that
  watches presence count and a poll deadline; on threshold, force a
  `handleStartGame()`. ~1 day.
- Reason deferred: dedicated host is the v1 model; rooms need an active
  host to advance.

### P3 — Admin verbs (`AdminSystem.dm`, `Ban stuff.dm`, `Black Feather.dm`)
- Force-end / force-kick, mute/unmute, jump-to-player, ban list, donor
  perks, OOC-toggle, hush-chat.
- Some are already wired (`C2S_VOTE_KICK` does player-driven kick).
- Reason declined (see CLAUDE.md memory): user-facing admin tools wait
  for a real ops story.

---

## UI polish

### P2 — Plant_On_Body picker
- Server handler is wired (`C2S_PLANT_ITEM`); client triggers it on `M`
  with whatever's currently equipped.
- DM let you pick any item out of your inventory via a modal, and gave
  the target's KO/corpse-state explicit feedback.
- To upgrade: a tiny inventory-list modal that opens when no item is
  equipped, and an HP-bar peek for KO'd targets.

### P2 — PDA SMS UI
- Server handler exists (`C2S_PDA_SEND`) and routes to the existing
  `S2CPaperReceived` opcode. Client uses `usepda` to read the roster
  but has no compose flow.
- DM had a numeric keypad (`padbutton1-9`, `pdapress0-9`, `pdapresssend`)
  letting you punch in a recipient's PDA number and a body. Each player
  was assigned a `[rand(100,900)]-[rand(1000,9000)]` number at game
  start.
- To add: assign a 7-digit number per player at `assignSpawns()`, expose
  it on `S2CStudentRoster.entries[].pdaNumber`, ship a compose modal
  in the existing PDA scene.

### P3 — Chat color preferences
- DM let players pick per-channel colors (`ChangeChatColor`,
  `chatboxbgcolor`, `tabbgcolor`, `splittercolor`, `fightfontchange`).
- Out of scope per user direction (CLAUDE.md memory).

### P3 — Profile / character slots
- DM persisted 3 character slots (`ChrSlot1-3`), hair customization
  (`changehaircolor`, `changegndr`), achievement unlocks (`Unlocks.dm`),
  donor flag (`CheckSubs.dm`).
- v1 uses anonymous device auth; profile = username only.
- Out of scope per user direction.

### P3 — Per-user ignore list
- DM `AddIgnore` / `RemIgnore` muted a specific player's chat.
- Could be added as a self-only filter in `ChatOverlay.ts` without
  server changes (keep the server cost down). ~2h.

---

## NPC AI

### P2 — Slender Mode AI antagonist
- DM Slender mode pits players vs an AI-controlled Slender Man with
  pursuit + teleport behavior (`Zombie AI.dm` is misnamed; the real
  Slender AI is split across `Tsukihime.dm` + `Zombie AI.dm`).
- Currently TS makes the slender role player-controlled; this changes
  the mode dynamic.
- To add: server-driven NPC entity in `state.npcs`, a tick-loop pursuit
  proc using `engine/proximity.ts`, broadcasts via `S2C_PLAYER_MOVED`
  on a synthesised userId. Significant — 3–5 days.

### P2 — Zombie Mode NPC variant
- DM Zombie had a 375-HP main NPC zombie that hunted players, with
  player-controlled minion zombies infecting on hit. TS only ships the
  player-zombie + infection chain.
- Same NPC machinery as Slender; share the implementation.

---

## Misc gameplay

### P3 — Class-roster classroom assignment
- Done as of commit `3177fbb`. Listed for completeness.

### P3 — Combat evade/crit/glance
- Done as of commit `3177fbb`.

### P3 — Stats persistence
- DM tracked games-played / wins-by-role / favorite-mode and showed an
  end-of-round stat sheet.
- Hooks into the same Storage layer as profile, which is declined.
  Re-evaluate with profiles in v1.x.

### P3 — Boom Box (custom music upload)
- DM let players upload a custom audio file (≤135KB) that played for
  everyone within 9 tiles.
- Out of scope: file upload + content-moderation risk too high without
  a moderator workflow.

### P3 — Pay Phone
- Dead in DM (`"The phone is dead."`). Ignore.

### P3 — Per-surface footstep sample variants
- DM had per-floor samples (tatami vs concrete vs grass). Currently one
  `footsteps.wav`.
- Out of scope per user direction.

---

## Tooling / infra

### P2 — Browser smoke flake
- `tools/smoke/m4.mjs` body-discovery test fails ~50% of runs depending
  on which player Math.random picks for the killer role. The test
  assumes alice (the first attacker) is civilian.
- Fix: smoke should request a specific role assignment via a debug RPC,
  or the smoke should detect "round ended early" and skip the body
  discovery assertion.

### P3 — Helm chart + production deploy
- Empty `infra/helm/` slot in the original plan. Currently `infra/`
  has only `docker-compose.yml`. Production deploy was always a
  post-launch milestone.

### P3 — Sentry / Prometheus / Grafana wiring
- Nakama exposes `/metrics`; nothing scrapes it yet. Client has no
  Sentry. M8 milestone in the original plan.

---

When picking up an item from this list, search the codebase for the
quoted opcode names / state fields / function names — they're already
chosen. The original DM source for any item is at commit `4a330e8`.
