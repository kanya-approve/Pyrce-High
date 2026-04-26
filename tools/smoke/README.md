# Smoke tests

End-to-end smoke harnesses that drive the running stack via the official
Nakama JS SDK. Useful for milestone verification without booting a browser.

This is its own pnpm workspace package (`@pyrce/smoke`) so the imports
resolve cleanly without leaning on hoisting.

## Prereqs

- Compose stack running: `docker compose -f infra/docker-compose.yml up`
- Latest server bundle deployed: `pnpm -F @pyrce/server build`

## Running

```bash
pnpm -F @pyrce/smoke run m1
```

Or directly:

```bash
node tools/smoke/m1.mjs
```

(The latter only works because pnpm has installed deps into
`tools/smoke/node_modules/`.)

## Tests

| File | Milestone | What it asserts |
|---|---|---|
| `m1.mjs` | M1 | Two clients can authenticate, one creates a match, the other lists+joins it, both see each other (initial presences for late-joiner, presence event for the host), both can leave cleanly. |
